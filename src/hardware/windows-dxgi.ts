/** DXGI capacities and D3D12 UMA evidence, collected inside the existing PowerShell probe. */
// ABI: IDXGIFactory1::EnumAdapters1 (12), IDXGIAdapter1::GetDesc1 (10),
// ID3D12Device::CheckFeatureSupport (13); Windows SDK dxgi.h / d3d12.h.
const source = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AtomicDxgi {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Desc {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string Description;
    public uint VendorId, DeviceId, SubSysId, Revision;
    public UIntPtr DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
    public uint LuidLow; public int LuidHigh; public uint Flags;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct Architecture { public uint NodeIndex; public int TileBasedRenderer, UMA, CacheCoherentUMA; }
  public class Row {
    public uint VendorId, DeviceId, SubSysId;
    public ulong DedicatedVideoMemory, SharedSystemMemory;
    public bool? uma;
  }
  [DllImport("dxgi.dll", ExactSpelling=true)]
  static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
  [DllImport("d3d12.dll", ExactSpelling=true)]
  static extern int D3D12CreateDevice(IntPtr adapter, uint level, ref Guid iid, out IntPtr device);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int Enumerate(IntPtr self, uint index, out IntPtr adapter);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int Describe(IntPtr self, out Desc desc);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  delegate int Feature(IntPtr self, int feature, ref Architecture architecture, uint size);
  static Delegate Method(IntPtr obj, int slot, Type type) {
    return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size), type);
  }
  static bool? Uma(IntPtr adapter) {
    IntPtr device = IntPtr.Zero;
    try {
      Guid iid = new Guid("189819f1-1db6-4b57-be54-1821339b85f7");
      if (D3D12CreateDevice(adapter, 0xb000, ref iid, out device) < 0) return null;
      Architecture architecture = new Architecture();
      int hr = ((Feature)Method(device, 13, typeof(Feature)))(device, 1, ref architecture, 16);
      return hr < 0 ? (bool?)null : architecture.UMA != 0;
    } catch { return null; }
    finally { if (device != IntPtr.Zero) Marshal.Release(device); }
  }
  public static Row[] Read() {
    List<Row> rows = new List<Row>();
    IntPtr factory = IntPtr.Zero;
    try {
      Guid iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
      if (CreateDXGIFactory1(ref iid, out factory) < 0) return rows.ToArray();
      Enumerate next = (Enumerate)Method(factory, 12, typeof(Enumerate));
      for (uint i = 0; i < 64; i++) {
        IntPtr adapter = IntPtr.Zero;
        try {
          if (next(factory, i, out adapter) < 0) break;
          Desc desc;
          if (((Describe)Method(adapter, 10, typeof(Describe)))(adapter, out desc) < 0 || (desc.Flags & 2) != 0) continue;
          rows.Add(new Row { VendorId=desc.VendorId, DeviceId=desc.DeviceId, SubSysId=desc.SubSysId,
            DedicatedVideoMemory=desc.DedicatedVideoMemory.ToUInt64(), SharedSystemMemory=desc.SharedSystemMemory.ToUInt64(),
            uma=desc.VendorId == 0x1002 ? Uma(adapter) : null });
        } finally { if (adapter != IntPtr.Zero) Marshal.Release(adapter); }
      }
      return rows.ToArray();
    } finally { if (factory != IntPtr.Zero) Marshal.Release(factory); }
  }
}`
// Keep the parent -Command script quote-free, including on Windows PowerShell 5.1.
const literal = source
  .trim()
  .replace(/\s+/g, ' ')
  .split('"')
  .map((part) => `'${part.replaceAll("'", "''")}'`)
  .join(' + [char]34 + ')
export const WINDOWS_DXGI_PROBE = `try { Add-Type -TypeDefinition (${literal}) -ErrorAction Stop; $dxgi = @([AtomicDxgi]::Read()) } catch { $dxgi = @() }`

/** Match exact PCI identity; ambiguous duplicates or failed UMA queries never create shared capacity. */
export function windowsDxgiMemory(
  raw: unknown,
  pnp: string
): {
  vramTotalMiB?: number
  sharedMemoryMiB?: number
  integrated?: boolean
} {
  const id = /PCI\\VEN_([\dA-F]{4})&DEV_([\dA-F]{4})&SUBSYS_([\dA-F]{8})/i.exec(pnp)
  if (!id) return {}
  const ids = id.slice(1).map((part) => Number.parseInt(part, 16))
  const rows = (Array.isArray(raw) ? raw : [raw]).filter(
    (row): row is Record<string, unknown> =>
      !!row &&
      typeof row === 'object' &&
      !Array.isArray(row) &&
      ['VendorId', 'DeviceId', 'SubSysId'].every((key, i) => (row as Record<string, unknown>)[key] === ids[i])
  )
  if (rows.length !== 1) return {}
  const row = rows[0]!
  const mib = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? Math.floor(value / 2 ** 20)
      : undefined
  const dedicated = mib(row['DedicatedVideoMemory'])
  const shared = ids[0] === 0x1002 && row['uma'] === true ? mib(row['SharedSystemMemory']) : undefined
  return {
    ...(dedicated !== undefined ? { vramTotalMiB: dedicated } : {}),
    ...(shared !== undefined && shared > 0 ? { sharedMemoryMiB: shared } : {}),
    ...(ids[0] === 0x1002 && typeof row['uma'] === 'boolean' ? { integrated: row['uma'] } : {}),
  }
}
