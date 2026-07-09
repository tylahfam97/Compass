# Generates branded installer BMP images for Compass.
#
# Sizes required by Tauri:
#   NSIS sidebar  (Welcome/Finish):  164 x 314
#   NSIS header   (inner pages):     150 x  57
#   WiX banner    (inner pages):     493 x  58
#   WiX dialog    (Welcome/Finish):  493 x 312
#
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\generate-installer-images.ps1

Add-Type -AssemblyName System.Drawing

$iconPath = Join-Path $PSScriptRoot "..\src-tauri\icons\icon.png"
$outDir   = Join-Path $PSScriptRoot "..\src-tauri\icons"

$navy    = [System.Drawing.Color]::FromArgb(14,  27,  60)
$gold    = [System.Drawing.Color]::FromArgb(201, 149, 43)
$white   = [System.Drawing.Color]::White
$textSub = [System.Drawing.Color]::FromArgb(160, 175, 210)

# Load icon into an unlocked 32bpp bitmap
$iconRaw = [System.Drawing.Image]::FromFile((Resolve-Path $iconPath))
$icon    = New-Object System.Drawing.Bitmap $iconRaw.Width, $iconRaw.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$tg = [System.Drawing.Graphics]::FromImage($icon)
$tg.DrawImage($iconRaw, 0, 0, $iconRaw.Width, $iconRaw.Height)
$tg.Dispose(); $iconRaw.Dispose()

function New-G($bmp) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    return $g
}

function Save-Bmp($bmp, $path) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp)
    [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
    $ms.Dispose()
    Write-Host "Saved: $path"
}

$goldB  = New-Object System.Drawing.SolidBrush($gold)
$subB   = New-Object System.Drawing.SolidBrush($textSub)
$navyB  = New-Object System.Drawing.SolidBrush($navy)
$verB   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100, 120, 160))

$fmtC = New-Object System.Drawing.StringFormat
$fmtC.Alignment     = [System.Drawing.StringAlignment]::Center
$fmtC.LineAlignment = [System.Drawing.StringAlignment]::Near

# 1. NSIS SIDEBAR 164x314
$bmp = New-Object System.Drawing.Bitmap 164, 314
$g = New-G $bmp
$g.Clear($navy)
$g.FillRectangle($goldB, 0, 0, 164, 4)
$iSz = 96; $iX = [int]((164 - $iSz) / 2)
$g.DrawImage($icon, $iX, 36, $iSz, $iSz)
$f1 = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Compass", $f1, $goldB, 82, 148, $fmtC)
$g.FillRectangle($goldB, 22, 172, 120, 1)
$f2 = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Personal Finance", $f2, $subB, 82, 180, $fmtC)
$f3 = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("v0.3.79", $f3, $verB, 82, 285, $fmtC)
$g.FillRectangle($goldB, 0, 310, 164, 4)
$g.Dispose()
Save-Bmp $bmp (Join-Path $outDir "installer-sidebar.bmp")
$bmp.Dispose()

# 2. NSIS HEADER 150x57
$bmp = New-Object System.Drawing.Bitmap 150, 57
$g = New-G $bmp
$g.Clear($navy)
$gradR = New-Object System.Drawing.Rectangle 0, 0, 60, 57
$grad  = New-Object System.Drawing.Drawing2D.LinearGradientBrush($gradR, $white, $navy, [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
$g.FillRectangle($grad, 0, 0, 60, 57); $grad.Dispose()
$g.FillRectangle($goldB, 0, 0, 3, 57)
$hiSz = 40; $hiX = 150 - $hiSz - 8; $hiY = [int]((57 - $hiSz) / 2)
$g.DrawImage($icon, $hiX, $hiY, $hiSz, $hiSz)
$f4 = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmtL = New-Object System.Drawing.StringFormat
$fmtL.Alignment = [System.Drawing.StringAlignment]::Near
$fmtL.LineAlignment = [System.Drawing.StringAlignment]::Center
$tR = New-Object System.Drawing.RectangleF 8, 0, 85, 57
$g.DrawString("Compass", $f4, $goldB, $tR, $fmtL)
$g.Dispose()
Save-Bmp $bmp (Join-Path $outDir "installer-header.bmp")
$bmp.Dispose()

# 3. WiX BANNER 493x58 — white left (WiX text), navy right (branding)
$bmp = New-Object System.Drawing.Bitmap 493, 58
$g = New-G $bmp
$g.Clear($white)
$g.FillRectangle($navyB, 340, 0, 153, 58)
$g.FillRectangle($goldB, 340, 0, 2, 58)
$wbISz = 38; $wbIX = 493 - $wbISz - 10; $wbIY = [int]((58 - $wbISz) / 2)
$g.DrawImage($icon, $wbIX, $wbIY, $wbISz, $wbISz)
$f5 = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmtR = New-Object System.Drawing.StringFormat
$fmtR.Alignment = [System.Drawing.StringAlignment]::Far
$fmtR.LineAlignment = [System.Drawing.StringAlignment]::Center
$wbTR = New-Object System.Drawing.RectangleF 344, 0, ($wbIX - 344 - 4), 58
$g.DrawString("Compass", $f5, $goldB, $wbTR, $fmtR)
$g.Dispose()
Save-Bmp $bmp (Join-Path $outDir "installer-wix-banner.bmp")
$bmp.Dispose()

# 4. WiX DIALOG 493x312 — navy left sidebar (165px), white right (WiX text)
$bmp = New-Object System.Drawing.Bitmap 493, 312
$g = New-G $bmp
$g.Clear($white)
$g.FillRectangle($navyB, 0, 0, 165, 312)
$g.FillRectangle($goldB, 0, 0, 165, 4)
$g.FillRectangle($goldB, 0, 308, 165, 4)
$g.FillRectangle($goldB, 165, 0, 2, 312)
$wdISz = 90; $wdIX = [int]((165 - $wdISz) / 2)
$g.DrawImage($icon, $wdIX, 50, $wdISz, $wdISz)
$f6 = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmtSb = New-Object System.Drawing.StringFormat
$fmtSb.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("Compass", $f6, $goldB, 82, 153, $fmtSb)
$g.FillRectangle($goldB, 12, 180, 141, 1)
$f7 = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Personal Finance", $f7, $subB, 82, 188, $fmtSb)
$g.Dispose()
Save-Bmp $bmp (Join-Path $outDir "installer-wix-dialog.bmp")
$bmp.Dispose()

$icon.Dispose()
foreach ($b in @($goldB, $subB, $navyB, $verB)) { $b.Dispose() }
Write-Host "`nAll installer images generated successfully."