<#
.SYNOPSIS
  Recognizes handwritten ink strokes using the Microsoft.Ink (Tablet PC) API.

.DESCRIPTION
  Reads a JSON file whose path is passed as -InputFile.
  The JSON is an array of strokes; each stroke is an array of { x, y } objects.
  All coordinates are already normalized by the caller (bounding box starts at 0,0).

  Uses Microsoft.Ink.InkRecognizerContext (synchronous, standard .NET assembly).
  This avoids the WinRT IAsyncOperation<T> COM interop issues encountered with
  Windows.UI.Input.Inking from PowerShell.

  Writes recognized text to stdout.
  Writes diagnostic information to stderr.

.PARAMETER InputFile
  Absolute path to the temporary JSON file written by the Node main process.
#>
param([string]$InputFile)

$ErrorActionPreference = 'Stop'

try {
  # ------------------------------------------------------------------
  # 1. Load System.Drawing for Point type used by Microsoft.Ink
  # ------------------------------------------------------------------
  Add-Type -AssemblyName System.Drawing

  # ------------------------------------------------------------------
  # 2. Locate and load Microsoft.Ink.dll (Tablet PC managed API).
  #    Standard .NET assembly -- no WinRT interop needed.
  #    Ships with Windows 10/11 when handwriting recognizers are installed.
  # ------------------------------------------------------------------
  $inkDll = $null
  $searchPaths = @(
    (Join-Path $env:ProgramFiles      'Common Files\Microsoft Shared\Ink\Microsoft.Ink.dll'),
    (Join-Path ${env:ProgramFiles(x86)} 'Common Files\Microsoft Shared\Ink\Microsoft.Ink.dll'),
    (Join-Path $env:SystemRoot        'System32\Microsoft.Ink.dll'),
    (Join-Path $env:SystemRoot        'SysWOW64\Microsoft.Ink.dll')
  )
  foreach ($p in $searchPaths) {
    if ($p -and (Test-Path $p)) { $inkDll = $p; break }
  }

  if ($inkDll) {
    [Console]::Error.WriteLine("Loading Microsoft.Ink from: $inkDll")
    Add-Type -Path $inkDll
  } else {
    # Fallback: try the GAC (version shipped with Windows Vista/7/8/10)
    [Console]::Error.WriteLine('Microsoft.Ink.dll not found on disk -- trying GAC...')
    try {
      Add-Type -AssemblyName 'Microsoft.Ink, Version=6.1.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35'
    } catch {
      throw "Microsoft.Ink.dll not found. Ensure Tablet PC / Windows Ink components are installed."
    }
  }

  # ------------------------------------------------------------------
  # 3. Verify at least one handwriting recognizer is installed
  # ------------------------------------------------------------------
  $recognizers = [Microsoft.Ink.Recognizers]::new()
  if ($recognizers.Count -eq 0) {
    [Console]::Error.WriteLine('No handwriting recognizers found. Install a Windows handwriting language pack.')
    Write-Output ''
    exit 0
  }
  [Console]::Error.WriteLine("Recognizers available: $($recognizers.Count), first: $($recognizers[0].Name)")

  # ------------------------------------------------------------------
  # 4. Read stroke data from the temp file
  # ------------------------------------------------------------------
  $json       = Get-Content -Raw -LiteralPath $InputFile
  $strokeData = $json | ConvertFrom-Json

  if (-not $strokeData -or $strokeData.Count -eq 0) {
    Write-Output ''
    exit 0
  }

  [Console]::Error.WriteLine("Strokes to process: $($strokeData.Count)")

  # ------------------------------------------------------------------
  # 5. Build Microsoft.Ink.Ink object with strokes.
  #    CreateStroke() takes System.Drawing.Point[] (integers).
  #    Scale by 26.4 to approximate HIMETRIC units (0.01mm per unit,
  #    assuming ~96 DPI screen: 1 px = 26.46 HIMETRIC units).
  #    Exact scale does not affect recognition -- shape is what counts.
  # ------------------------------------------------------------------
  $ink       = [Microsoft.Ink.Ink]::new()
  $builtCount = 0
  $SCALE = 26.4

  foreach ($strokePts in $strokeData) {
    if ($strokePts.Count -lt 2) { continue }

    $points = [System.Drawing.Point[]]::new($strokePts.Count)
    for ($i = 0; $i -lt $strokePts.Count; $i++) {
      $points[$i] = [System.Drawing.Point]::new(
        [int][Math]::Round($strokePts[$i].x * $SCALE),
        [int][Math]::Round($strokePts[$i].y * $SCALE)
      )
    }
    $null = $ink.CreateStroke($points)
    $builtCount++
  }

  [Console]::Error.WriteLine("InkStrokes built: $builtCount")

  if ($builtCount -eq 0) {
    Write-Output ''
    exit 0
  }

  # ------------------------------------------------------------------
  # 6. Recognize -- synchronous, no WinRT async needed
  # ------------------------------------------------------------------
  $context                  = [Microsoft.Ink.RecognizerContext]::new()
  # RecognitionFlags must be set BEFORE assigning Strokes — the API enforces this order.
  # WordMode: tells the recognizer the input is a single word, improving accuracy for
  # word-sized stroke groups produced by our clustering step.
  $context.RecognitionFlags = [Microsoft.Ink.RecognitionModes]::WordMode
  $context.Strokes          = $ink.Strokes

  $recoStatus = [Microsoft.Ink.RecognitionStatus]::NoError
  $result     = $context.Recognize([ref]$recoStatus)

  [Console]::Error.WriteLine("Recognition status: $recoStatus")

  $text = ''
  if ($null -ne $result -and $recoStatus -eq [Microsoft.Ink.RecognitionStatus]::NoError) {
    $text = $result.TopString
  }

  [Console]::Error.WriteLine("Recognized: '$text'")
  Write-Output $text

} catch {
  [Console]::Error.WriteLine("recognize.ps1 error: $($_.Exception.Message)")
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  Write-Output ''
  exit 1
}
