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

    if (-not $asTaskDef) { throw 'AsTask extension method not found — check System.Runtime.WindowsRuntime is loaded.' }

    $tArg    = $asyncOp.GetType().GetGenericArguments()[0]
    $asTask  = $asTaskDef.MakeGenericMethod($tArg)
    $netTask = $asTask.Invoke($null, @($asyncOp))
    $netTask.GetAwaiter().GetResult()
  }

  # ------------------------------------------------------------------
  # 3. Load WinRT ink types
  # ------------------------------------------------------------------
  $null = [Windows.UI.Input.Inking.InkRecognizerContainer,  Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkStrokeBuilder,        Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkPoint,                Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkRecognitionTarget,    Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.Foundation.Point,                        Windows.Foundation,       ContentType=WindowsRuntime]

  # ------------------------------------------------------------------
  # 4. Verify at least one handwriting recognizer is installed
  # ------------------------------------------------------------------
  $container   = [Windows.UI.Input.Inking.InkRecognizerContainer]::new()
  $recognizers = $container.GetRecognizers()
  if ($recognizers.Count -eq 0) {
    [Console]::Error.WriteLine('No handwriting recognizers found. Install a Windows handwriting language pack.')
    Write-Output ''
    exit 0
  }

  # ------------------------------------------------------------------
  # 5. Read stroke data from the temp file
  # ------------------------------------------------------------------
  $json       = Get-Content -Raw -LiteralPath $InputFile
  $strokeData = $json | ConvertFrom-Json

  if (-not $strokeData -or $strokeData.Count -eq 0) {
    Write-Output ''
    exit 0
  }

  # ------------------------------------------------------------------
  # 6. Build InkStroke objects
  #    Use typed generic lists so WinRT IIterable<T> marshalling works.
  # ------------------------------------------------------------------
  $builder    = [Windows.UI.Input.Inking.InkStrokeBuilder]::new()
  $identity   = [System.Numerics.Matrix3x2]::Identity

  # Typed list of InkStroke — PowerShell resolves the WinRT type here
  # because it was already loaded via ContentType=WindowsRuntime above.
  $strokeList = New-Object 'System.Collections.Generic.List[Windows.UI.Input.Inking.InkStroke]'

  foreach ($strokePts in $strokeData) {
    if ($strokePts.Count -lt 2) { continue }

    # Typed list of InkPoint
    $inkPtList = New-Object 'System.Collections.Generic.List[Windows.UI.Input.Inking.InkPoint]'

    foreach ($pt in $strokePts) {
      $winPt = [Windows.Foundation.Point]::new([double]$pt.x, [double]$pt.y)
      $inkPt = [Windows.UI.Input.Inking.InkPoint]::new($winPt, [float]0.5)
      $inkPtList.Add($inkPt)
    }

    $stroke = $builder.CreateStrokeFromInkPoints($inkPtList, $identity)
    $strokeList.Add($stroke)
  }

  if ($strokeList.Count -eq 0) {
    Write-Output ''
    exit 0
  }

  # ------------------------------------------------------------------
  # 7. Run recognition
  # ------------------------------------------------------------------
  $asyncOp = $container.RecognizeAsync(
    $strokeList,
    [Windows.UI.Input.Inking.InkRecognitionTarget]::All
  )
  $results = Await-WinRT $asyncOp

  # ------------------------------------------------------------------
  # 8. Collect best candidate from each result segment
  # ------------------------------------------------------------------
  $words = @()
  foreach ($result in $results) {
    $candidates = $result.GetTextCandidates()
    if ($candidates.Count -gt 0) {
      $words += $candidates[0]
    }
  }

  Write-Output ($words -join ' ')

} catch {
  # Write full error to stderr so Node.js can log it — stdout stays empty
  # so the caller treats this page as unsearchable without crashing.
  [Console]::Error.WriteLine("recognize.ps1 error: $($_.Exception.Message)")
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  Write-Output ''
  exit 1
}
