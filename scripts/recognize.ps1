<#
.SYNOPSIS
  Recognizes handwritten ink strokes using the Windows Ink API.

.DESCRIPTION
  Reads a JSON file whose path is passed as -InputFile.
  The JSON is an array of strokes; each stroke is an array of { x, y } objects.
  All coordinates are already normalized by the caller (bounding box starts at 0,0).

  Uses Windows.UI.Input.Inking.InkRecognizerContainer (built into Windows 10/11).
  Writes recognized text to stdout.
  Writes diagnostic information to stderr on failure.

.PARAMETER InputFile
  Absolute path to the temporary JSON file written by the Node main process.

.NOTES
  Windows.Foundation.Point is NOT loaded by name — its assembly reference varies
  across Windows versions. Instead we derive its Type from InkPoint's constructor
  parameter, which is guaranteed to be consistent after InkPoint is loaded.
#>
param([string]$InputFile)

$ErrorActionPreference = 'Stop'

try {
  # ------------------------------------------------------------------
  # 1. Load WinRT and Numerics support
  # ------------------------------------------------------------------
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Numerics

  # ------------------------------------------------------------------
  # 2. Generic helper: block on WinRT IAsyncOperation<T>
  #    Derives T from the async-op's own runtime type automatically.
  # ------------------------------------------------------------------
  function Await-WinRT($asyncOp) {
    $methods   = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $asTaskDef = $methods | Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1

    if (-not $asTaskDef) { throw 'AsTask extension method not found.' }

    $tArg    = $asyncOp.GetType().GetGenericArguments()[0]
    $asTask  = $asTaskDef.MakeGenericMethod($tArg)
    $netTask = $asTask.Invoke($null, @($asyncOp))
    $netTask.GetAwaiter().GetResult()
  }

  # ------------------------------------------------------------------
  # 3. Load WinRT ink types (Windows.Foundation loads as a dependency)
  #    Do NOT try to load Windows.Foundation.Point by name — the winmd
  #    assembly hint differs across Windows versions and fails.
  # ------------------------------------------------------------------
  $null = [Windows.UI.Input.Inking.InkRecognizerContainer,  Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkStrokeBuilder,        Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkPoint,                Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkRecognitionTarget,    Windows.UI.Input.Inking, ContentType=WindowsRuntime]

  # ------------------------------------------------------------------
  # 4. Derive Windows.Foundation.Point from InkPoint's constructor.
  #    This works because loading InkPoint also loads its dependencies,
  #    including Point — we just navigate to it via reflection instead
  #    of guessing the assembly name.
  # ------------------------------------------------------------------
  $inkPtCtor  = [Windows.UI.Input.Inking.InkPoint].GetConstructors() |
                Where-Object { $_.GetParameters().Count -ge 2 } |
                Select-Object -First 1

  if (-not $inkPtCtor) { throw 'Could not find InkPoint constructor with 2+ parameters.' }

  $pointType  = $inkPtCtor.GetParameters()[0].ParameterType  # Windows.Foundation.Point
  $pointCtor  = $pointType.GetConstructors() |
                Where-Object { $_.GetParameters().Count -eq 2 } |
                Select-Object -First 1

  if (-not $pointCtor) { throw "Could not find Point(x,y) constructor on $($pointType.FullName)." }

  function New-Point($x, $y) {
    # Invoke Point(double x, double y) via the reflected constructor
    $pointCtor.Invoke(@([double]$x, [double]$y))
  }

  # ------------------------------------------------------------------
  # 5. Verify at least one handwriting recognizer is installed
  # ------------------------------------------------------------------
  $container   = [Windows.UI.Input.Inking.InkRecognizerContainer]::new()
  $recognizers = $container.GetRecognizers()
  if ($recognizers.Count -eq 0) {
    [Console]::Error.WriteLine('No handwriting recognizers found. Install a Windows handwriting language pack.')
    Write-Output ''
    exit 0
  }
  [Console]::Error.WriteLine("Recognizers available: $($recognizers.Count) — using: $($recognizers[0].Name)")

  # ------------------------------------------------------------------
  # 6. Read stroke data from the temp file
  # ------------------------------------------------------------------
  $json       = Get-Content -Raw -LiteralPath $InputFile
  $strokeData = $json | ConvertFrom-Json

  if (-not $strokeData -or $strokeData.Count -eq 0) {
    Write-Output ''
    exit 0
  }

  [Console]::Error.WriteLine("Strokes to process: $($strokeData.Count)")

  # ------------------------------------------------------------------
  # 7. Build InkStroke objects using typed generic lists
  # ------------------------------------------------------------------
  $builder    = [Windows.UI.Input.Inking.InkStrokeBuilder]::new()
  $identity   = [System.Numerics.Matrix3x2]::Identity
  $strokeList = New-Object 'System.Collections.Generic.List[Windows.UI.Input.Inking.InkStroke]'

  foreach ($strokePts in $strokeData) {
    if ($strokePts.Count -lt 2) { continue }

    $inkPtList = New-Object 'System.Collections.Generic.List[Windows.UI.Input.Inking.InkPoint]'

    foreach ($pt in $strokePts) {
      $winPt = New-Point $pt.x $pt.y
      $inkPt = [Windows.UI.Input.Inking.InkPoint]::new($winPt, [float]0.5)
      $inkPtList.Add($inkPt)
    }

    $stroke = $builder.CreateStrokeFromInkPoints($inkPtList, $identity)
    $strokeList.Add($stroke)
  }

  [Console]::Error.WriteLine("InkStrokes built: $($strokeList.Count)")

  if ($strokeList.Count -eq 0) {
    Write-Output ''
    exit 0
  }

  # ------------------------------------------------------------------
  # 8. Run recognition
  # ------------------------------------------------------------------
  $asyncOp = $container.RecognizeAsync(
    $strokeList,
    [Windows.UI.Input.Inking.InkRecognitionTarget]::All
  )
  $results = Await-WinRT $asyncOp
  [Console]::Error.WriteLine("Recognition results: $($results.Count)")

  # ------------------------------------------------------------------
  # 9. Collect best candidate from each result segment
  # ------------------------------------------------------------------
  $words = @()
  foreach ($result in $results) {
    $candidates = $result.GetTextCandidates()
    if ($candidates.Count -gt 0) {
      $words += $candidates[0]
    }
  }

  $text = $words -join ' '
  [Console]::Error.WriteLine("Recognized: '$text'")
  Write-Output $text

} catch {
  [Console]::Error.WriteLine("recognize.ps1 error: $($_.Exception.Message)")
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  Write-Output ''
  exit 1
}
