# 从 sts2.dll 导出每个角色的初始最大生命（CharacterModel 子类里的 get_StartingHp 整数常量）
# 输出：D:\tts-server\sts2-ui\assets\character_hp.json
# 规矩：游戏数值只能从游戏本体读，不许照 wiki 抄（2026-11-24 定）。
# 用法：powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\extract_character_hp.ps1
$ErrorActionPreference = 'Stop'
Add-Type -Path 'D:\tts-server\tools\cecil\Mono.Cecil.dll'
$asmPath = 'D:\steam\steamapps\common\Slay the Spire 2\data_sts2_windows_x86_64\sts2.dll'
$outPath = 'D:\tts-server\sts2-ui\assets\character_hp.json'

$asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($asmPath)
$mod = $asm.MainModule
function Walk($types) { foreach ($t in $types) { $t; if ($t.HasNestedTypes) { Walk $t.NestedTypes } } }
$every = @(Walk @($mod.Types))

$hp = [ordered]@{}
$skip = @('RandomCharacter', 'RotatingCharacter', 'DeprecatedCharacter', 'Deprived')
foreach ($t in $every) {
    if ($t.BaseType -eq $null -or $t.BaseType.Name -ne 'CharacterModel') { continue }
    if ($skip -contains $t.Name) { continue }
    $m = $t.Methods | Where-Object { $_.Name -eq 'get_StartingHp' } | Select-Object -First 1
    if (-not $m -or -not $m.HasBody) { continue }
    # 取靠近 ret 的最后一个整数常量
    $val = $null
    foreach ($i in $m.Body.Instructions) {
        if ($i.OpCode.Code -eq [Mono.Cecil.Cil.Code]::Ldc_I4 -or $i.OpCode.Code -eq [Mono.Cecil.Cil.Code]::Ldc_I4_S) { $val = [int]$i.Operand }
        elseif ($i.OpCode.Code.ToString() -match '^Ldc_I4_[0-8]$') {
            $val = [int]($i.OpCode.Code.ToString().Substring(7))
        }
    }
    if ($val -ne $null) { $hp[$t.Name.ToUpper()] = $val }
}

$json = $hp | ConvertTo-Json -Compress
[IO.File]::WriteAllText($outPath, $json, (New-Object Text.UTF8Encoding($false)))
"已写 $outPath"
$json
