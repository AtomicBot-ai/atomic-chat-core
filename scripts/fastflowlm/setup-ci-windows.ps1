# Run on a clean windows-2022 hosted runner, which has VS17. Install the
# same VS18 tools used for the Windows hardware run in a separate instance.
$ErrorActionPreference = 'Stop'
$lock = Get-Content "$PSScriptRoot/provenance.json" -Raw | ConvertFrom-Json
$pins = $lock.windows
$root = Join-Path $env:RUNNER_TEMP 'flm-tools'
New-Item -ItemType Directory $root | Out-Null
function Get-PinnedFile($Url, $Hash, $Path) {
    curl.exe --fail --location --silent --show-error --retry 3 $Url --output $Path
    if ($LASTEXITCODE -or (Get-FileHash $Path).Hash -ne $Hash) { throw "Download failed validation: $Path" }
}
$installer = "$root/vs_BuildTools.exe"
Get-PinnedFile $pins.build_tools.url $pins.build_tools.sha256 $installer
$setup = Start-Process $installer -ArgumentList '--quiet','--wait','--norestart','--installPath','C:\flm-vs18','--add','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','--add','Microsoft.VisualStudio.Component.Windows11SDK.26100' -Wait -PassThru
if ($setup.ExitCode -notin 0,3010) { throw "VS setup exited $($setup.ExitCode)" }
$cmake = "cmake-$($pins.cmake)-windows-x86_64"
Get-PinnedFile "https://github.com/Kitware/CMake/releases/download/v$($pins.cmake)/$cmake.zip" $pins.cmake_zip_sha256 "$root/cmake.zip"
tar.exe -xf "$root/cmake.zip" -C $root
if ($LASTEXITCODE) { throw 'CMake extraction failed' }
"$root/$cmake/bin" >> $env:GITHUB_PATH
git init -q "$root/vcpkg"
git -C "$root/vcpkg" fetch --depth 1 https://github.com/microsoft/vcpkg.git $pins.vcpkg
if ($LASTEXITCODE) { throw 'vcpkg fetch failed' }
git -C "$root/vcpkg" checkout --detach FETCH_HEAD
if ($LASTEXITCODE) { throw 'vcpkg checkout failed' }
& "$root/vcpkg/bootstrap-vcpkg.bat" -disableMetrics
if ($LASTEXITCODE) { throw 'vcpkg bootstrap failed' }
"VCPKG_INSTALLATION_ROOT=$root/vcpkg" >> $env:GITHUB_ENV
rustup toolchain install $lock.rust --profile minimal
if ($LASTEXITCODE) { throw 'Rust installation failed' }
"RUSTUP_TOOLCHAIN=$($lock.rust)" >> $env:GITHUB_ENV
