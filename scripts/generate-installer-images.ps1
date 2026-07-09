# Generates branded NSIS installer BMP images for Compass.
# Sizes required by Tauri/NSIS:
#   Sidebar header (Welcome/Finish pages): 164 x 314
#   Page header banner (all other pages):  150 x  57
#
# Run from repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\generate-installer-images.ps1

Add-Type -AssemblyName System.Drawing

$iconPath   = Join-Path $PSScriptRoot "..\src-tauri\icons\icon.png"
$outDir     = Join-Path $PSScriptRoot "..\src-tauri\icons"

# ── Brand colours ──────────────────────────────────────────────────────────────
$navy       = [System.Drawing.Color]::FromArgb(14,  27,  60)   # #0e1b3c
$navyLight  = [System.Drawing.Color]::FromArgb(22,  42,  90)   # accent block
$gold       = [System.Drawing.Color]::FromArgb(201, 149, 43)   # #c9952b
$white      = [System.Drawing.Color]::White
$textSub    = [System.Drawing.Color]::FromArgb(160, 175, 210)  # light blue-grey

$icon = [System.Drawing.Image]::FromFile((Resolve-Path $iconPath))

function New-Graphics([System.Drawing.Bitmap]$bmp) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    return $g
}

# ── Helper: draw rounded rectangle ────────────────────────────────────────────
function Draw-RoundedRect($g, $x, $y, $w, $h, $r, $brush) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x,           $y,           $r, $r, 180, 90)
    $path.AddArc($x + $w - $r, $y,           $r, $r, 270, 90)
    $path.AddArc($x + $w - $r, $y + $h - $r, $r, $r,   0, 90)
    $path.AddArc($x,           $y + $h - $r, $r, $r,  90, 90)
    $path.CloseFigure()
    $g.FillPath($brush, $path)
    $path.Dispose()
}

# ══════════════════════════════════════════════════════════════════════════════
# 1. SIDEBAR IMAGE  164 × 314
# ══════════════════════════════════════════════════════════════════════════════
$sw = 164; $sh = 314
$sidebar = New-Object System.Drawing.Bitmap $sw, $sh
$g = New-Graphics $sidebar

# Background — solid deep navy
$g.Clear($navy)

# Thin gold top bar
$goldBrush = New-Object System.Drawing.SolidBrush($gold)
$g.FillRectangle($goldBrush, 0, 0, $sw, 4)

# Compass icon — 96 × 96, centred horizontally, upper third
$iSize = 96
$iX    = [int](($sw - $iSize) / 2)
$iY    = 36
$g.DrawImage($icon, $iX, $iY, $iSize, $iSize)

# "Compass" wordmark — gold, bold
$fontMain = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmtC = New-Object System.Drawing.StringFormat
$fmtC.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("Compass", $fontMain, $goldBrush, ($sw / 2), 148, $fmtC)

# Thin gold rule under the wordmark
$g.FillRectangle($goldBrush, 22, 172, $sw - 44, 1)

# "Personal Finance" subtitle — light blue-grey
$fontSub  = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$subBrush = New-Object System.Drawing.SolidBrush($textSub)
$g.DrawString("Personal Finance", $fontSub, $subBrush, ($sw / 2), 180, $fmtC)

# Version caption area at bottom
$fontVer  = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$verBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100, 120, 160))
$g.DrawString("v0.3.78", $fontVer, $verBrush, ($sw / 2), 285, $fmtC)

# Thin gold bottom bar
$g.FillRectangle($goldBrush, 0, $sh - 4, $sw, 4)

$g.Dispose()
$sidebarPath = Join-Path $outDir "installer-sidebar.bmp"
$sidebar.Save($sidebarPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$sidebar.Dispose()
Write-Host "Saved: $sidebarPath"

# ══════════════════════════════════════════════════════════════════════════════
# 2. HEADER IMAGE  150 × 57
# ══════════════════════════════════════════════════════════════════════════════
$hw = 150; $hh = 57
$header = New-Object System.Drawing.Bitmap $hw, $hh
$g = New-Graphics $header

# Navy background
$g.Clear($navy)

# White gradient on the left edge so it blends with NSIS's white text area
$gradRect = New-Object System.Drawing.Rectangle 0, 0, 60, $hh
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $gradRect,
    $white,
    $navy,
    [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal
)
$g.FillRectangle($grad, 0, 0, 60, $hh)
$grad.Dispose()

# Gold left accent bar
$g.FillRectangle($goldBrush, 0, 0, 3, $hh)

# Compass icon — 40 × 40 on right side
$hiSize = 40
$hiX    = $hw - $hiSize - 8
$hiY    = [int](($hh - $hiSize) / 2)
$g.DrawImage($icon, $hiX, $hiY, $hiSize, $hiSize)

# "Compass" text in gold (sits left of icon, over the gradient)
$fontH  = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmtL   = New-Object System.Drawing.StringFormat
$fmtL.Alignment = [System.Drawing.StringAlignment]::Near
$fmtL.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF 8, 0, 85, $hh
$g.DrawString("Compass", $fontH, $goldBrush, $textRect, $fmtL)

$g.Dispose()
$headerPath = Join-Path $outDir "installer-header.bmp"
$header.Save($headerPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$header.Dispose()
Write-Host "Saved: $headerPath"

# ══════════════════════════════════════════════════════════════════════════════
# 3. WiX BANNER  493 × 58   (top of all but first page)
# ══════════════════════════════════════════════════════════════════════════════
$wbw = 493; $wbh = 58
$wixBanner = New-Object System.Drawing.Bitmap $wbw, $wbh
$g = New-Graphics $wixBanner

$g.Clear($navy)

# White gradient on left ~200px (blends with MSI's white text area)
$gradRect2 = New-Object System.Drawing.Rectangle 0, 0, 200, $wbh
$grad2 = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $gradRect2, $white, $navy,
    [System.Drawing.Drawing2D.LinearGradientMode]::Horizontal)
$g.FillRectangle($grad2, 0, 0, 200, $wbh)
$grad2.Dispose()

# Gold left accent bar
$g.FillRectangle($goldBrush, 0, 0, 3, $wbh)

# Compass icon — 42 × 42 on far right
$wbiSize = 42
$wbiX    = $wbw - $wbiSize - 10
$wbiY    = [int](($wbh - $wbiSize) / 2)
$g.DrawImage($icon, $wbiX, $wbiY, $wbiSize, $wbiSize)

# "Compass" label in gold
$fontWB = New-Object System.Drawing.Font("Segoe UI", 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmtWBL = New-Object System.Drawing.StringFormat
$fmtWBL.Alignment = [System.Drawing.StringAlignment]::Near
$fmtWBL.LineAlignment = [System.Drawing.StringAlignment]::Center
$wbTextRect = New-Object System.Drawing.RectangleF 10, 0, 200, $wbh
$g.DrawString("Compass", $fontWB, $goldBrush, $wbTextRect, $fmtWBL)

$g.Dispose()
$wixBannerPath = Join-Path $outDir "installer-wix-banner.bmp"
$wixBanner.Save($wixBannerPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$wixBanner.Dispose()
Write-Host "Saved: $wixBannerPath"

# ══════════════════════════════════════════════════════════════════════════════
# 4. WiX DIALOG  493 × 312   (Welcome / Finish pages)
# ══════════════════════════════════════════════════════════════════════════════
$wdw = 493; $wdh = 312
$wixDialog = New-Object System.Drawing.Bitmap $wdw, $wdh
$g = New-Graphics $wixDialog

$g.Clear($navy)

# Gold top bar
$g.FillRectangle($goldBrush, 0, 0, $wdw, 4)

# Compass icon — centred upper area
$wdiSize = 110
$wdiX    = [int](($wdw - $wdiSize) / 2)
$g.DrawImage($icon, $wdiX, 48, $wdiSize, $wdiSize)

# "Compass" wordmark
$fontWD  = New-Object System.Drawing.Font("Segoe UI", 28, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmtWDC  = New-Object System.Drawing.StringFormat
$fmtWDC.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString("Compass", $fontWD, $goldBrush, ($wdw / 2), 172, $fmtWDC)

# Divider
$g.FillRectangle($goldBrush, 40, 208, $wdw - 80, 1)

# Subtitle
$fontWDS  = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString("Personal Finance", $fontWDS, $subBrush, ($wdw / 2), 216, $fmtWDC)

# Gold bottom bar
$g.FillRectangle($goldBrush, 0, $wdh - 4, $wdw, 4)

$g.Dispose()
$wixDialogPath = Join-Path $outDir "installer-wix-dialog.bmp"
$wixDialog.Save($wixDialogPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$wixDialog.Dispose()
Write-Host "Saved: $wixDialogPath"

# ── Clean up ──────────────────────────────────────────────────────────────────
$icon.Dispose()
$goldBrush.Dispose()
$subBrush.Dispose()
$verBrush.Dispose()

Write-Host "`nInstaller images generated successfully."
