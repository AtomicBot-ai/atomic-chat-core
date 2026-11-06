// Embedded in the trusted executable, compiled by Windows PowerShell in administrator-owned TEMP.
// SetupCopyOEMInf stages the signed package. DiInstallDevice binds only the requested devnode.
export const NPU_SETUP_API = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AtomicNpuSetup {
    [StructLayout(LayoutKind.Sequential)]
    struct Device {
        public uint Size;
        public Guid ClassGuid;
        public uint DevInst;
        public IntPtr Reserved;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct InstallParams {
        public uint Size, Flags, FlagsEx;
        public IntPtr Parent, Handler, Context, Queue, ClassReserved;
        public uint Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string DriverPath;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Driver {
        public uint Size, Type;
        public IntPtr Reserved;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Description;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Manufacturer;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Provider;
        public System.Runtime.InteropServices.ComTypes.FILETIME Date;
        public ulong Version;
    }
    [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool SetupCopyOEMInf(string inf, string media, uint mediaType, uint style,
        StringBuilder published, uint size, out uint used, IntPtr component);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr guid, IntPtr parent);
    [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool SetupDiOpenDeviceInfo(IntPtr set, string id, IntPtr parent, uint flags, ref Device device);
    [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool SetupDiGetDeviceInstallParams(IntPtr set, ref Device device, ref InstallParams p);
    [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool SetupDiSetDeviceInstallParams(IntPtr set, ref Device device, ref InstallParams p);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern bool SetupDiBuildDriverInfoList(IntPtr set, ref Device device, uint kind);
    [DllImport("setupapi.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern bool SetupDiEnumDriverInfo(IntPtr set, ref Device device, uint kind, uint index, ref Driver driver);
    [DllImport("newdev.dll", SetLastError=true)]
    static extern bool DiInstallDevice(IntPtr parent, IntPtr set, ref Device device, ref Driver driver, uint flags, out bool reboot);
    [DllImport("setupapi.dll")]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);

    static void Check(bool ok) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    public static int SelectDriver(string id, string inf, bool install) {
        var set = SetupDiCreateDeviceInfoList(IntPtr.Zero, IntPtr.Zero);
        if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var device = new Device { Size=(uint)Marshal.SizeOf(typeof(Device)) };
            Check(SetupDiOpenDeviceInfo(set, id, IntPtr.Zero, 0, ref device));
            if (install) {
                var published = new StringBuilder(260);
                uint used;
                Check(SetupCopyOEMInf(inf, null, 1 /* SPOST_PATH */, 0, published, 260, out used, IntPtr.Zero));
                inf = published.ToString();
            }
            var p = new InstallParams { Size=(uint)Marshal.SizeOf(typeof(InstallParams)) };
            Check(SetupDiGetDeviceInstallParams(set, ref device, ref p));
            p.Flags |= 0x10000; // DI_ENUMSINGLEINF
            p.FlagsEx |= 0x800; // DI_FLAGSEX_ALLOWEXCLUDEDDRVS
            p.DriverPath = inf;
            Check(SetupDiSetDeviceInstallParams(set, ref device, ref p));
            const uint compatibleDrivers = 2;
            Check(SetupDiBuildDriverInfoList(set, ref device, compatibleDrivers));
            var driver = new Driver { Size=(uint)Marshal.SizeOf(typeof(Driver)) };
            Check(SetupDiEnumDriverInfo(set, ref device, compatibleDrivers, 0, ref driver));
            if (driver.Version != ((32UL << 48) | (203UL << 16) | 314UL))
                throw new InvalidOperationException("Unexpected compatible driver version.");
            if (!install) return 0;
            bool reboot;
            Check(DiInstallDevice(IntPtr.Zero, set, ref device, ref driver, 0, out reboot));
            return reboot ? 3010 : 0;
        }
        finally { SetupDiDestroyDeviceInfoList(set); }
    }
}`
