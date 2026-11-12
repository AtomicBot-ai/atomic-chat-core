/**
 * `FoundryLibrary` over `bun:ffi` — allow-listed to import `bun:*` (operator decision Q2 of change
 * `add-foundry-local`, ADR 2026-10-15-foundry-local-runs-in-a-host-mode-of-the-core-binary;
 * allow-listed in `scripts/check-runtime-agnostic.mjs`). It is
 * imported dynamically by the `foundry-host` mode alone, so the npm package still loads under Node.
 *
 * The library exports three symbols; everything else is a table of function pointers (`flApi` and its
 * sub-APIs), read here by index. Indices follow `foundry_local_c.h` of C API versions 2 and 3: tables only
 * ever grow at the end, so a library that grants version 2 keeps these positions.
 *
 * Proven by the spike (rulings S1, S2): progress callbacks must not be `threadsafe` — the native caller
 * would wait on a JS thread it itself blocks and read a non-zero return as "cancel"; on Windows the
 * library's DLL dependencies are found only after `SetDllDirectoryW(<lib>)`.
 */

import { CFunction, CString, dlopen, FFIType, JSCallback, ptr, read } from 'bun:ffi'
import type { NativeArgument, Pointer } from 'bun:ffi'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { foundryWindowsCudaCache, foundryWindowsDllDirectories } from './windows-dlls.js'
import { FoundryLibraryError, selectFoundryApi } from './library.js'
import { requiresBundledOpenVino, withBundledOpenVino } from './openvino.js'
import { ensureMacWebGpu, requiresMacWebGpu, withMacWebGpu } from './webgpu/index.js'
import type {
  DiscoverableEp,
  FoundryLibrary,
  FoundryManager,
  FoundryManagerConfig,
  FoundryModel,
  LoadFoundryLibrary,
  ModelMetadata,
} from './library.js'

const POINTER = 8
const CATALOG_LOCAL = 1
/** `flEpInfo`: u32 version, padding, `const char* name` at 8, `bool is_registered` at 16. */
const EP_INFO_SIZE = 24

const LIBRARY_FILE: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'foundry_local.dll',
  darwin: 'libfoundry_local.dylib',
  linux: 'libfoundry_local.so',
}

/** Root table (`flApi`) indices. */
const API = {
  statusGetErrorCode: 2,
  statusGetErrorMessage: 3,
  statusRelease: 1,
  managerCreate: 4,
  managerRelease: 5,
  webServiceStart: 7,
  webServiceUrls: 8,
  getCatalogApi: 10,
  getConfigurationApi: 11,
  getModelApi: 14,
  createKeyValuePairs: 15,
  addKeyValuePair: 16,
  keyValuePairsRelease: 20,
  getDiscoverableEps: 24,
  downloadAndRegisterEps: 25,
  managerShutdown: 27,
  getCatalogByType: 29,
} as const
const CONFIG = {
  create: 0,
  release: 1,
  setAppDataDir: 3,
  setLogsDir: 4,
  setModelCacheDir: 5,
  addWebServiceEndpoint: 8,
  setAdditionalOptions: 10,
} as const
const CATALOG = { registerModel: 8 } as const
const MODEL = {
  getInfo: 0,
  load: 6,
  unload: 7,
  infoGetExecutionProvider: 17,
  createModelInfo: 23,
  releaseModelInfo: 24,
  infoSetStringProperty: 25,
  infoSetIntProperty: 26,
} as const

const T = FFIType
const cstr = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf8')
const outPointer = (): BigUint64Array => new BigUint64Array(1)
const deref = (out: BigUint64Array): Pointer => Number(out[0])

function windowsSystemCudaDirectories(): string[] {
  const children = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
  }
  const discovered: string[] = []
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const cudaRoot = join(programFiles, 'NVIDIA GPU Computing Toolkit', 'CUDA')
  const cudnnRoot = join(programFiles, 'NVIDIA', 'CUDNN')
  for (const version of children(cudaRoot).filter((version) => /^v12(?:\.|$)/.test(version)))
    discovered.push(join(cudaRoot, version, 'bin'), join(cudaRoot, version, 'bin', 'x64'))
  const cudnnRoots = [
    ...children(cudnnRoot)
      .filter((version) => /^v9(?:\.|$)/.test(version))
      .map((version) => join(cudnnRoot, version)),
    ...(process.env['CUDNN_PATH'] ? [process.env['CUDNN_PATH']] : []),
  ]
  for (const root of cudnnRoots) {
    const bin = join(root, 'bin')
    discovered.push(
      bin,
      ...children(bin)
        .filter((version) => /^12(?:\.|$)/.test(version))
        .map((version) => join(bin, version))
    )
  }
  return discovered
}

export const loadBunFoundryLibrary: LoadFoundryLibrary = async (libDir) => {
  const file = LIBRARY_FILE[process.platform]
  if (!file) throw new FoundryLibraryError('load', 0, `Foundry Local has no library for ${process.platform}`)
  const path = join(libDir, file)
  if (!existsSync(path))
    throw new FoundryLibraryError('load', 0, `${path} not found: no ${file} in this build`)
  if (process.platform === 'win32') {
    // All loader changes stay in this child. Keep the build's dependencies and PATH providers,
    // and expose CUDA/cuDNN directories to LoadLibraryEx(LOAD_LIBRARY_SEARCH_USER_DIRS).
    const kernel32 = dlopen('kernel32.dll', {
      SetDllDirectoryW: { args: [T.ptr], returns: T.i32 },
      SetDefaultDllDirectories: { args: [T.u32], returns: T.i32 },
      AddDllDirectory: { args: [T.ptr], returns: T.ptr },
      LoadLibraryExW: { args: [T.ptr, T.ptr, T.u32], returns: T.ptr },
      GetLastError: { args: [], returns: T.u32 },
    })
    const wide = (value: string) => ptr(Buffer.from(`${value}\0`, 'utf16le'))
    if (!kernel32.symbols.SetDllDirectoryW(wide(libDir)))
      throw new FoundryLibraryError('load', 0, 'Windows could not configure the Foundry DLL directory')
    const cudaCache = foundryWindowsCudaCache(process.env)
    // A managed CUDA host searches only the Foundry build, its CUDA cache and System32.
    // AddDllDirectory does not promise an order when several directories supply the same DLL.
    const searchFlags = cudaCache ? 0x0c00 : 0x1000
    if (process.arch === 'x64' || cudaCache) {
      const discovered = cudaCache ? [] : windowsSystemCudaDirectories()
      if (!kernel32.symbols.SetDefaultDllDirectories(searchFlags))
        throw new FoundryLibraryError('load', 0, 'Windows could not configure the Foundry DLL search path')
      for (const dir of foundryWindowsDllDirectories(libDir, process.env, discovered)) {
        if (dir === cudaCache) {
          if (!kernel32.symbols.AddDllDirectory(wide(dir)))
            throw new FoundryLibraryError(
              'load',
              0,
              `Windows could not open the Foundry CUDA cache at ${dir}.`
            )
        } else if (existsSync(dir)) {
          kernel32.symbols.AddDllDirectory(wide(dir))
        }
      }
    }
    // DLL_LOAD_DIR precedes the process search path for dependencies. In particular, Windows'
    // own onnxruntime.dll must not replace the newer ORT shipped beside foundry_local.dll.
    // Keep this handle for the child's lifetime; dlopen below binds the already loaded module.
    if (!kernel32.symbols.LoadLibraryExW(wide(path), null, 0x100 | searchFlags))
      throw new FoundryLibraryError(
        'load',
        0,
        `Windows could not load ${path} and its dependencies (error ${String(kernel32.symbols.GetLastError())})`
      )
  }
  const library = dlopen(path, {
    FoundryLocalGetApi: { args: [T.u32], returns: T.ptr },
    FoundryLocalGetVersionString: { args: [], returns: T.cstring },
  })
  const version = String(library.symbols.FoundryLocalGetVersionString())
  const { api, cApiVersion } = selectFoundryApi(
    version,
    (requested) => library.symbols.FoundryLocalGetApi(requested) as Pointer | null
  )
  return bindLibrary(api, version, cApiVersion, libDir)
}

/**
 * The pinned Intel EP is registered on ORT's shared process environment, which Foundry also uses.
 * Acquire our own environment reference lazily: CPU/CUDA and installation probes need no Intel DLLs.
 * Release it only after the manager and its sessions. DLL handles remain pinned for this child.
 * OrtApi slots follow the original Microsoft.ML.OnnxRuntime 1.31.0 onnxruntime_c_api.h.
 */
function bundledOpenVino(libDir: string): { register(): void; release(): void } {
  let releaseEnv: (() => void) | undefined
  return {
    register() {
      if (releaseEnv) return
      const dir = join(libDir, 'openvino')
      const path = join(dir, 'onnxruntime_providers_openvino_plugin.dll')
      if (!existsSync(path))
        throw new FoundryLibraryError(
          'OpenVINO',
          0,
          'This Foundry 2.4.0 build is missing the bundled Intel OpenVINO 1.8.1 EP. Reinstall the NPU-compatible Windows x64 build.'
        )
      const kernel = dlopen('kernel32.dll', {
        AddDllDirectory: { args: [T.ptr], returns: T.ptr },
        LoadLibraryExW: { args: [T.ptr, T.ptr, T.u32], returns: T.ptr },
        GetLastError: { args: [], returns: T.u32 },
      })
      const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le')
      if (
        !kernel.symbols.AddDllDirectory(ptr(wide(dir))) ||
        !kernel.symbols.LoadLibraryExW(ptr(wide(path)), null, 0x1100)
      )
        throw new FoundryLibraryError(
          'OpenVINO',
          0,
          `Windows could not load the bundled Intel OpenVINO EP (error ${String(kernel.symbols.GetLastError())}). Reinstall this Foundry build and check the Intel NPU driver.`
        )
      const ort = dlopen(join(libDir, 'onnxruntime.dll'), {
        OrtGetApiBase: { args: [], returns: T.ptr },
      })
      const base = ort.symbols.OrtGetApiBase() as Pointer
      const api = CFunction({ ptr: read.ptr(base), args: [T.u32], returns: T.ptr })(31) as Pointer | null
      if (!api) throw new FoundryLibraryError('OpenVINO', 0, 'The bundled Intel EP requires ORT API 31')
      const fn = (index: number, args: number[], returns: number) =>
        CFunction({ ptr: read.ptr(api, index * POINTER), args, returns })
      const statusCode = fn(1, [T.ptr], T.i32)
      const statusMessage = fn(2, [T.ptr], T.cstring)
      const statusRelease = fn(93, [T.ptr], T.void)
      const check = (status: unknown) => {
        if (!status) return
        const code = Number(statusCode(status as Pointer))
        const message = String(statusMessage(status as Pointer))
        statusRelease(status as Pointer)
        throw new FoundryLibraryError('OpenVINO', code, message)
      }
      const envOut = outPointer()
      check(fn(3, [T.i32, T.ptr, T.ptr], T.ptr)(3, ptr(cstr('atomic-foundry-openvino')), ptr(envOut)))
      const env = deref(envOut)
      const release = () => fn(92, [T.ptr], T.void)(env)
      try {
        check(
          fn(301, [T.ptr, T.ptr, T.ptr], T.ptr)(
            env,
            ptr(cstr('atomic-foundry-openvino-1.8.1')),
            ptr(wide(path))
          )
        )
        releaseEnv = release
      } catch (error) {
        release()
        throw error
      }
    },
    release() {
      releaseEnv?.()
      releaseEnv = undefined
    },
  }
}

/** Register the pinned Mac EP in the same ORT environment used by Foundry/GenAI. */
function macWebGpu(libDir: string, config: FoundryManagerConfig) {
  let releaseEnv: (() => void) | undefined
  return {
    async register(onProgress?: (percent: number) => void) {
      if (releaseEnv) return
      const file = await ensureMacWebGpu({
        runtimeDir: config.appDataDir,
        allowDownload: config.allowEpDownloads === true,
        fetch,
        ...(onProgress ? { onProgress } : {}),
      })
      const ort = dlopen(join(libDir, 'libonnxruntime.1.dylib'), {
        OrtGetApiBase: { args: [], returns: T.ptr },
      })
      const base = ort.symbols.OrtGetApiBase() as Pointer
      const api = CFunction({ ptr: read.ptr(base), args: [T.u32], returns: T.ptr })(31) as Pointer | null
      if (!api) throw new FoundryLibraryError('WebGPU', 0, 'The pinned Mac WebGPU EP requires ORT API 31')
      const fn = (index: number, args: number[], returns: number) =>
        CFunction({ ptr: read.ptr(api, index * POINTER), args, returns })
      const code = fn(1, [T.ptr], T.i32)
      const message = fn(2, [T.ptr], T.cstring)
      const releaseStatus = fn(93, [T.ptr], T.void)
      const check = (status: unknown) => {
        if (!status) return
        const error = new FoundryLibraryError(
          'WebGPU',
          Number(code(status as Pointer)),
          String(message(status as Pointer))
        )
        releaseStatus(status as Pointer)
        throw error
      }
      const envOut = outPointer()
      check(fn(3, [T.i32, T.ptr, T.ptr], T.ptr)(3, ptr(cstr('atomic-foundry-webgpu')), ptr(envOut)))
      const env = deref(envOut)
      const release = () => fn(92, [T.ptr], T.void)(env)
      try {
        check(
          fn(301, [T.ptr, T.ptr, T.ptr], T.ptr)(
            env,
            ptr(cstr('atomic-foundry-webgpu-0.2.1')),
            ptr(cstr(file))
          )
        )
        releaseEnv = release
      } catch (error) {
        release()
        throw error
      }
    },
    release() {
      releaseEnv?.()
      releaseEnv = undefined
    },
  }
}

function bindLibrary(api: Pointer, version: string, cApiVersion: number, libDir: string): FoundryLibrary {
  const fn = (table: Pointer, index: number, args: number[], returns: number) =>
    CFunction({ ptr: read.ptr(table, index * POINTER), args, returns })

  const statusCode = fn(api, API.statusGetErrorCode, [T.ptr], T.i32)
  const statusMessage = fn(api, API.statusGetErrorMessage, [T.ptr], T.cstring)
  const statusRelease = fn(api, API.statusRelease, [T.ptr], T.void)
  /** A non-null `flStatus*` is an error: read it, free it, throw it. */
  const check = (status: unknown, operation: string): void => {
    if (!status) return
    const code = Number(statusCode(status as Pointer))
    const message = String(statusMessage(status as Pointer))
    statusRelease(status as Pointer)
    throw new FoundryLibraryError(operation, code, message)
  }
  const call = (f: (...args: NativeArgument[]) => unknown, operation: string, ...args: NativeArgument[]) =>
    check(f(...args), operation)

  const configApi = fn(api, API.getConfigurationApi, [], T.ptr)() as Pointer
  const catalogApi = fn(api, API.getCatalogApi, [], T.ptr)() as Pointer
  const modelApi = fn(api, API.getModelApi, [], T.ptr)() as Pointer
  const f = {
    configCreate: fn(configApi, CONFIG.create, [T.ptr, T.ptr], T.ptr),
    configRelease: fn(configApi, CONFIG.release, [T.ptr], T.void),
    setAppDataDir: fn(configApi, CONFIG.setAppDataDir, [T.ptr, T.ptr], T.ptr),
    setLogsDir: fn(configApi, CONFIG.setLogsDir, [T.ptr, T.ptr], T.ptr),
    setModelCacheDir: fn(configApi, CONFIG.setModelCacheDir, [T.ptr, T.ptr], T.ptr),
    addWebServiceEndpoint: fn(configApi, CONFIG.addWebServiceEndpoint, [T.ptr, T.ptr], T.ptr),
    setAdditionalOptions: fn(configApi, CONFIG.setAdditionalOptions, [T.ptr, T.ptr], T.ptr),
    kvCreate: fn(api, API.createKeyValuePairs, [T.ptr], T.void),
    kvAdd: fn(api, API.addKeyValuePair, [T.ptr, T.ptr, T.ptr], T.void),
    kvRelease: fn(api, API.keyValuePairsRelease, [T.ptr], T.void),
    managerCreate: fn(api, API.managerCreate, [T.ptr, T.ptr], T.ptr),
    managerRelease: fn(api, API.managerRelease, [T.ptr], T.void),
    managerShutdown: fn(api, API.managerShutdown, [T.ptr], T.ptr),
    getDiscoverableEps: fn(api, API.getDiscoverableEps, [T.ptr, T.ptr, T.ptr], T.ptr),
    downloadAndRegisterEps: fn(api, API.downloadAndRegisterEps, [T.ptr, T.ptr, T.u64, T.ptr, T.ptr], T.ptr),
    getCatalogByType: fn(api, API.getCatalogByType, [T.ptr, T.i32, T.ptr], T.ptr),
    webServiceStart: fn(api, API.webServiceStart, [T.ptr], T.ptr),
    webServiceUrls: fn(api, API.webServiceUrls, [T.ptr, T.ptr, T.ptr], T.ptr),
    registerModel: fn(catalogApi, CATALOG.registerModel, [T.ptr, T.ptr, T.ptr, T.ptr, T.ptr], T.ptr),
    modelGetInfo: fn(modelApi, MODEL.getInfo, [T.ptr, T.ptr], T.ptr),
    modelLoad: fn(modelApi, MODEL.load, [T.ptr], T.ptr),
    modelUnload: fn(modelApi, MODEL.unload, [T.ptr], T.ptr),
    infoGetExecutionProvider: fn(modelApi, MODEL.infoGetExecutionProvider, [T.ptr], T.cstring),
    createModelInfo: fn(modelApi, MODEL.createModelInfo, [T.ptr], T.ptr),
    releaseModelInfo: fn(modelApi, MODEL.releaseModelInfo, [T.ptr], T.void),
    infoSetString: fn(modelApi, MODEL.infoSetStringProperty, [T.ptr, T.ptr, T.ptr], T.ptr),
    infoSetInt: fn(modelApi, MODEL.infoSetIntProperty, [T.ptr, T.ptr, T.i64], T.ptr),
  }

  function createManager(config: FoundryManagerConfig): FoundryManager {
    const configOut = outPointer()
    call(f.configCreate, 'Configuration_Create', ptr(cstr(config.appName)), ptr(configOut))
    const cfg = deref(configOut)
    let manager: Pointer
    try {
      call(f.setAppDataDir, 'SetAppDataDir', cfg, ptr(cstr(config.appDataDir)))
      call(f.setLogsDir, 'SetLogsDir', cfg, ptr(cstr(config.logsDir)))
      call(f.setModelCacheDir, 'SetModelCacheDir', cfg, ptr(cstr(config.modelCacheDir)))
      for (const endpoint of config.webServiceEndpoints)
        call(f.addWebServiceEndpoint, 'AddWebServiceEndpoint', cfg, ptr(cstr(endpoint)))
      const kvOut = outPointer()
      f.kvCreate(ptr(kvOut))
      const kv = deref(kvOut)
      for (const [key, value] of Object.entries(config.additionalOptions))
        f.kvAdd(kv, ptr(cstr(key)), ptr(cstr(value)))
      try {
        call(f.setAdditionalOptions, 'SetAdditionalOptions', cfg, kv)
      } finally {
        f.kvRelease(kv)
      }
      const managerOut = outPointer()
      call(f.managerCreate, 'Manager_Create', cfg, ptr(managerOut))
      manager = deref(managerOut)
    } finally {
      f.configRelease(cfg)
    }
    const bound = bindManager(manager)
    if (requiresMacWebGpu(process.platform, process.arch, version))
      return withMacWebGpu(bound, macWebGpu(libDir, config))
    return requiresBundledOpenVino(process.platform, process.arch, version)
      ? withBundledOpenVino(bound, bundledOpenVino(libDir))
      : bound
  }

  function bindManager(manager: Pointer): FoundryManager {
    return {
      discoverableEps(): DiscoverableEp[] {
        const epsOut = outPointer()
        const countOut = outPointer()
        call(f.getDiscoverableEps, 'Manager_GetDiscoverableEps', manager, ptr(epsOut), ptr(countOut))
        const base = deref(epsOut)
        const eps: DiscoverableEp[] = []
        for (let i = 0; i < Number(countOut[0]); i++) {
          const at = i * EP_INFO_SIZE
          eps.push({
            name: new CString(read.ptr(base, at + 8)).toString(),
            registered: read.u8(base, at + 16) !== 0,
          })
        }
        return eps
      },
      downloadAndRegisterEps(names, onProgress) {
        const strings = names.map(cstr)
        const array = new BigUint64Array(strings.map((s) => BigInt(ptr(s))))
        // Not threadsafe: the library calls back on the calling thread, synchronously (spike S1, S2).
        const callback = onProgress
          ? new JSCallback(
              (name: Pointer, percent: number) => {
                onProgress(new CString(name).toString(), percent)
                return 0
              },
              { args: [T.ptr, T.f32, T.ptr], returns: T.i32 }
            )
          : null
        try {
          call(
            f.downloadAndRegisterEps,
            'Manager_DownloadAndRegisterEps',
            manager,
            names.length > 0 ? ptr(array) : null,
            names.length,
            callback ? callback.ptr : null,
            null
          )
        } finally {
          callback?.close()
        }
      },
      registerLocalModel(path: string, id: string, metadata: ModelMetadata): FoundryModel {
        const catalogOut = outPointer()
        call(f.getCatalogByType, 'Manager_GetCatalogByType', manager, CATALOG_LOCAL, ptr(catalogOut))
        const infoOut = outPointer()
        call(f.createModelInfo, 'CreateModelInfo', ptr(infoOut))
        const info = deref(infoOut)
        const modelOut = outPointer()
        try {
          for (const [key, value] of Object.entries(metadata.strings))
            call(f.infoSetString, `Info_SetStringProperty(${key})`, info, ptr(cstr(key)), ptr(cstr(value)))
          for (const [key, value] of Object.entries(metadata.ints))
            call(f.infoSetInt, `Info_SetIntProperty(${key})`, info, ptr(cstr(key)), BigInt(value))
          call(
            f.registerModel,
            'RegisterModel',
            deref(catalogOut),
            ptr(cstr(path)),
            ptr(cstr(id)),
            info,
            ptr(modelOut)
          )
        } finally {
          f.releaseModelInfo(info)
        }
        return bindModel(deref(modelOut))
      },
      webServiceStart(): string[] {
        call(f.webServiceStart, 'Manager_WebServiceStart', manager)
        const urlsOut = outPointer()
        const countOut = outPointer()
        call(f.webServiceUrls, 'Manager_WebServiceUrls', manager, ptr(urlsOut), ptr(countOut))
        const urls: string[] = []
        for (let i = 0; i < Number(countOut[0]); i++)
          urls.push(new CString(read.ptr(deref(urlsOut), i * POINTER)).toString())
        return urls
      },
      shutdown: () => call(f.managerShutdown, 'Manager_Shutdown', manager),
      release: () => {
        f.managerRelease(manager)
      },
    }
  }

  function bindModel(model: Pointer): FoundryModel {
    return {
      load: () => call(f.modelLoad, 'Model_Load', model),
      unload: () => call(f.modelUnload, 'Model_Unload', model),
      executionProvider() {
        const infoOut = outPointer()
        call(f.modelGetInfo, 'Model_GetInfo', model, ptr(infoOut))
        const ep = f.infoGetExecutionProvider(deref(infoOut))
        return ep ? String(ep) : null
      },
    }
  }

  return { version, cApiVersion, createManager }
}
