param(
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [Parameter(Mandatory=$true)][string]$OutJson,
  [string]$Lang = 'zh-Hans-CN',
  [double]$Zoom = 3.0
)
# Card-name strip OCR for the deck-browser screen.
# The whole-image OCR misses short names (打击 / 防御) once the cards get small,
# because the name sits on a low-contrast strip. Cropping just the strip and
# upscaling it 3x recovers every name. Band geometry is in 1920x1080 space and
# scaled by actual width. All coordinates returned are original-image pixels.
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

$language = [Windows.Globalization.Language]::new($Lang)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'no OCR language pack (need zh-Hans-CN)' }

$src = [System.Drawing.Image]::FromFile((Resolve-Path $ImagePath).Path)
$W = $src.Width; $H = $src.Height
$k = $W / 1920.0
$rows = @()
for ($i = 0; $i -lt 4; $i++) {
  $bx = [int](130 * $k)
  $by = [int]((232 + 300 * $i) * $k)
  $bw = [int](1700 * $k)
  $bh = [int](90 * $k)
  if ($by -ge $H) { continue }
  if ($bx + $bw -gt $W) { $bw = $W - $bx }
  if ($by + $bh -gt $H) { $bh = $H - $by }
  if ($bw -le 40 -or $bh -le 24) { continue }
  $nw = [int]($bw * $Zoom); $nh = [int]($bh * $Zoom)
  $bmp = New-Object System.Drawing.Bitmap $nw, $nh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $dst = New-Object System.Drawing.Rectangle 0, 0, $nw, $nh
  $g.DrawImage($src, $dst, $bx, $by, $bw, $bh, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'sts2nr-' + [Guid]::NewGuid().ToString('N') + '.png')
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()

  try {
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
          x = [math]::Round($bx + $r.X / $Zoom, 1)
          y = [math]::Round($by + $r.Y / $Zoom, 1)
          w = [math]::Round($r.Width / $Zoom, 1)
          h = [math]::Round($r.Height / $Zoom, 1)
        }
      }
      if ($words.Count -gt 0) { $lines += [ordered]@{ text = $l.Text; words = $words } }
    }
    $rows += [ordered]@{ band = $i; y0 = $by; lines = $lines }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}
$src.Dispose()
$json = ConvertTo-Json -InputObject @{ scale = $Zoom; width = $W; rows = $rows } -Depth 8 -Compress
[IO.File]::WriteAllText($OutJson, $json, (New-Object Text.UTF8Encoding($false)))
