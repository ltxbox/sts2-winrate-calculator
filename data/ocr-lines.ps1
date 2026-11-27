param(
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [Parameter(Mandatory=$true)][string]$OutJson,
  [string]$Lang = 'zh-Hans-CN',
  [double]$Scale = 2.0
)
# OCR with box coordinates. Upscales the image first (small card names are unreadable at 1x),
# then divides all coordinates back by $Scale so callers get original-image coordinates.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $t) {
  $m = $asTaskGeneric.MakeGenericMethod($t)
  $task = $m.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

try {
  $src = [System.Drawing.Image]::FromFile((Resolve-Path $ImagePath).Path)
  $w = [int]($src.Width * $Scale)
  $h = [int]($src.Height * $Scale)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose()
  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'sts2ocr-' + [Guid]::NewGuid().ToString('N') + '.png')
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose(); $src.Dispose()

  $language = [Windows.Globalization.Language]::new($Lang)
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { throw 'no OCR language pack (need zh-Hans-CN)' }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sbmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($sbmp)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($l in $result.Lines) {
    $words = @()
    foreach ($wd in $l.Words) {
      $r = $wd.BoundingRect
      $words += [ordered]@{
        t = $wd.Text
        x = [math]::Round($r.X / $Scale, 1)
        y = [math]::Round($r.Y / $Scale, 1)
        w = [math]::Round($r.Width / $Scale, 1)
        h = [math]::Round($r.Height / $Scale, 1)
      }
    }
    $lines += [ordered]@{ text = $l.Text; words = $words }
  }
  $json = ConvertTo-Json -InputObject @{ scale = $Scale; lines = $lines } -Depth 8 -Compress
  [IO.File]::WriteAllText($OutJson, $json, (New-Object Text.UTF8Encoding($false)))
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
} catch {
  Write-Error ($_.Exception.Message + ' @ ' + $_.InvocationInfo.PositionMessage)
  exit 1
}
