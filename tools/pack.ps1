<#
  打「网页版计算器」分发包。
  用法：powershell -ExecutionPolicy Bypass -File tools\pack.ps1
  产物：dist\StS2胜率测算\  和  dist\StS2胜率测算-<日期>.zip

  和上一版（脚本版）的区别：这个是网页 UI，包内自带 node.exe，双击 启动.cmd 就能用。
  宁可麻烦点也要保证：包里不留开发者本机的绝对路径、harness/solver 都是打过补丁的那份。
#>
param(
    [string]$OutDir = 'D:\tts-server\sts2-ui\dist',
    [switch]$SkipAssets,
    [switch]$NoZip
)
$ErrorActionPreference = 'Stop'
$app = 'D:\tts-server\sts2-ui'
$pkgSrc = Join-Path $app 'pack'
$harnessSrc = Join-Path $app 'harness'
$solverDll = 'D:\tts-server\pr278\CombatSolver-d473297e4e7643b5bbdf0a1969aa3c7c9b7bbbfd\.godot\mono\temp\bin\Release\CombatSolver.dll'
# 2026-11-28：改成带 Rust 内核的 dll（PR#278 合并版）。rust 库按 dll 同级 rust-kernel\ 找，必须一起带。
$rustKernelDir = 'D:\tts-server\pr278\CombatSolver-d473297e4e7643b5bbdf0a1969aa3c7c9b7bbbfd\.godot\mono\temp\bin\Release\rust-kernel'
$nodeExe = 'C:\Users\123\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$assetsSrc = Join-Path $app 'assets_web'
$utf8 = New-Object Text.UTF8Encoding($false)
$encBom = New-Object Text.UTF8Encoding($true)

foreach ($f in @($solverDll, $nodeExe, (Join-Path $harnessSrc 'OfflineSearchHarness.exe'))) {
    if (-not (Test-Path $f)) { throw "缺文件：$f" }
}

# 0) 卡图缩图（有现成的就复用，除非 -SkipAssets 之外还过期）
if (-not $SkipAssets -or -not (Test-Path (Join-Path $assetsSrc 'meta.json'))) {
    Write-Host '缩卡图（258MB → ~15MB）…'
    $py = 'C:\Users\123\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
    $env:PYTHONIOENCODING = 'utf-8'
    & $py (Join-Path $app 'tools\shrink-assets.py') (Join-Path $app 'assets') $assetsSrc
    if ($LASTEXITCODE -ne 0) { throw '缩图失败' }
}

$pkgName = 'StS2胜率测算'
$root = Join-Path $OutDir $pkgName
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
foreach ($d in @('harness', 'solver', 'data', 'scripts', 'node', 'assets', 'public', 'logs', 'lib')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null
}

# 1) 服务端 + 前端
Copy-Item (Join-Path $app 'server.mjs') (Join-Path $root 'server.mjs')
Copy-Item (Join-Path $app 'public\*') (Join-Path $root 'public') -Recurse
# 截图识别用的纯 Node 模块（server.mjs 直接 import 它）
Copy-Item (Join-Path $app 'lib\*') (Join-Path $root 'lib') -Recurse
# 2) 数据（含自检用的请求模板）
Copy-Item (Join-Path $app 'data\*') (Join-Path $root 'data') -Recurse
# 结果库是使用者自己的数据，绝对不能进分发包
Get-ChildItem (Join-Path $root 'data') -Filter 'sts2.db*' -ErrorAction SilentlyContinue | Remove-Item -Force
Copy-Item (Join-Path $pkgSrc 'data\selftest-request.json') (Join-Path $root 'data\selftest-request.json')
# 3) 卡图（缩过的）
Copy-Item (Join-Path $assetsSrc '*') (Join-Path $root 'assets') -Recurse
# 3.1) 遗物图标特征（截图导入时前端拿它算相似度，不是图片文件，得单独带上）
Copy-Item (Join-Path $app 'assets\relic-feats.json') (Join-Path $root 'assets\relic-feats.json') -Force
# 4) 模拟器：exe + dll + deps（pdb 不带），runtimeconfig 做成模板
foreach ($f in @('OfflineSearchHarness.exe', 'OfflineSearchHarness.dll', 'OfflineSearchHarness.deps.json')) {
    Copy-Item (Join-Path $harnessSrc $f) (Join-Path $root "harness\$f")
}
$t = [IO.File]::ReadAllText((Join-Path $harnessSrc 'OfflineSearchHarness.runtimeconfig.json'))
$dev = [ordered]@{
    'Sts2DataDir'       = 'D:/steam/steamapps/common/Slay the Spire 2/data_sts2_windows_x86_64'
    'RitsuLibDir'       = 'D:/steam/steamapps/common/Slay the Spire 2/mods/STS2-RitsuLib.0.6.16.variant-pack/compat/0.114.0'
    'RitsuLibCompatDir' = 'D:/steam/steamapps/common/Slay the Spire 2/mods/STS2-RitsuLib.0.6.16.variant-pack/compat/0.114.0'
    'RitsuLibSharedDir' = 'D:/steam/steamapps/common/Slay the Spire 2/mods/STS2-RitsuLib.0.6.16.variant-pack/shared'
    'CombatSolverDll'   = 'D:/tts-server/pr278/CombatSolver-d473297e4e7643b5bbdf0a1969aa3c7c9b7bbbfd/.godot/mono/temp/bin/Release/CombatSolver.dll'
}
$ph = [ordered]@{
    'Sts2DataDir'       = '__STS2_DATA_DIR__'
    'RitsuLibDir'       = '__RITSULIB_DIR__'
    'RitsuLibCompatDir' = '__RITSULIB_COMPAT__'
    'RitsuLibSharedDir' = '__RITSULIB_SHARED__'
    'CombatSolverDll'   = '__COMBATSOLVER_DLL__'
}
foreach ($k in $ph.Keys) {
    # 不比对具体路径（开发机路径会变），直接把 "键": "任意值" 换成占位符
    $pat = '"' + $k + '":\s*"[^"]*"'
    $rep = '"' + $k + '": "' + $ph[$k] + '"'
    $t = [regex]::Replace($t, $pat, $rep)
}
if (($ph.Values | Where-Object { $t -notmatch [regex]::Escape($_) }).Count -gt 0) {
    throw 'runtimeconfig 占位符替换失败：检查 harness 里那份 runtimeconfig 是不是又多/少了字段'
}
[IO.File]::WriteAllText((Join-Path $root 'harness\OfflineSearchHarness.runtimeconfig.template.json'), $t, $utf8)
# 5) 求解器（打过补丁 + 带 Rust 内核的那份）
Copy-Item $solverDll (Join-Path $root 'solver\CombatSolver.dll')
# 5.1) Rust 内核原生库（弱怪走 rust 用；缺了会自动退回 hot，但等于白装）
New-Item -ItemType Directory -Force -Path (Join-Path $root 'solver\rust-kernel') | Out-Null
Copy-Item (Join-Path $rustKernelDir 'sts2_combat_rs.dll') (Join-Path $root 'solver\rust-kernel\sts2_combat_rs.dll')
# 6) 内置 node
Copy-Item $nodeExe (Join-Path $root 'node\node.exe')
# 7) 脚本
foreach ($f in @('common.ps1', 'start.ps1', 'stop.ps1')) {
    Copy-Item (Join-Path $pkgSrc "scripts\$f") (Join-Path $root "scripts\$f")
}

# 8) config.json（留空 = 自动探测）
$cfg = [ordered]@{
    sts2DataDir       = ''
    ritsuLibDir       = ''
    ritsuLibCompatDir = ''
    ritsuLibSharedDir = ''
    dotnet            = ''
    port              = 8766
}
[IO.File]::WriteAllText((Join-Path $root 'config.json'), ($cfg | ConvertTo-Json), $utf8)

# 9) 三个入口（内容必须纯 ASCII，否则 cmd 会乱码）
$launch  = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\start.ps1`"`r`n"
$diag    = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\start.ps1`" -DiagOnly`r`n"
$stop    = "@echo off`r`ncd /d `"%~dp0`"`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0scripts\stop.ps1`"`r`n"
[IO.File]::WriteAllText((Join-Path $root '启动.cmd'), $launch, $utf8)
[IO.File]::WriteAllText((Join-Path $root '自检.cmd'), $diag, $utf8)
[IO.File]::WriteAllText((Join-Path $root '停止服务.cmd'), $stop, $utf8)

# 10) 说明书（带 BOM，记事本不乱码）
Copy-Item (Join-Path $pkgSrc '说明书-分发包.md') (Join-Path $root '说明书.md')
$rd = [IO.File]::ReadAllText((Join-Path $root '说明书.md'))
[IO.File]::WriteAllText((Join-Path $root '说明书.md'), $rd, $encBom)

# 11) 打包前自检：不许留本机绝对路径；harness 里只能有模板，不能有已填好的 runtimeconfig
$bad = @()
Get-ChildItem $root -Recurse -File -Include *.mjs,*.js,*.json,*.ps1,*.cmd,*.md,*.html,*.css | ForEach-Object {
    $txt = [IO.File]::ReadAllText($_.FullName)
    if ($txt -match 'tts-server|C:\\Users\\123|\\fish\\|\\\\Fish\\\\') { $bad += ('本机路径: ' + $_.FullName.Replace($root + '\', '')) }
}
if (Test-Path (Join-Path $root 'harness\OfflineSearchHarness.runtimeconfig.json')) {
    $bad += 'harness 里带了已填好的 runtimeconfig.json（应该只有 template，让启动器现场生成）'
}
if ($bad.Count) { throw ("包里还有不该出现的东西：`n" + ($bad -join "`n")) }

# 12) 压缩
if (-not $NoZip) {
    $zip = Join-Path $OutDir ("{0}-{1}.zip" -f $pkgName, (Get-Date -Format 'yyyyMMdd'))
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path $root -DestinationPath $zip -CompressionLevel Optimal
    $sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
    "打包完成: $zip  ({0} MB)" -f $sizeMb
} else {
    "只生成目录: $root"
}
$files = @(Get-ChildItem $root -Recurse -File)
"文件数: $($files.Count)   目录大小: {0:N1} MB" -f (($files | Measure-Object Length -Sum).Sum / 1MB)
$files | Sort-Object Length -Descending | Select-Object -First 6 @{n='MB';e={[math]::Round($_.Length/1MB,2)}}, @{n='path';e={$_.FullName.Replace($root+'\','')}} | Format-Table -AutoSize
