<#
.SYNOPSIS
  Recognizes handwritten ink strokes using the Windows Ink API.

.DESCRIPTION
  Reads a JSON file whose path is passed as -InputFile.
  The JSON is an array of strokes; each stroke is an array of { x, y } objects.
  All coordinates are already normalized by the caller: the bounding box of the
  entire page group starts at (0, 0) so relative positions between strokes are
  preserved — critical for multi-stroke letters and words.

  Uses Windows.UI.Input.Inking.InkRecognizerContainer (built into Windows 10/11).
  Writes recognized text to stdout.
  Exits with code 0 on success or graceful failure; never throws to the caller.

.PARAMETER InputFile
  Absolute path to the temporary JSON file written by the Node main process.

.NOTES
  Requires a handwriting recognition language pack to be installed in Windows.
  If the API is unavailable or recognition fails, outputs an empty string so
  the caller can treat the annotation as unsearchable rather than crashing.
#>
param([string]$InputFile)

$ErrorActionPreference = 'SilentlyContinue'

try {
  # ------------------------------------------------------------------
  # 1. Load .NET WinRT support
  # ------------------------------------------------------------------
  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')
  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Numerics')

  # ------------------------------------------------------------------
  # 2. Generic helper: block on WinRT IAsyncOperation<T>
  #    Derives T from the async-op's own runtime type so we don't need
  #    to hard-code the result type.
  # ------------------------------------------------------------------
  function Await-WinRT($asyncOp) {
    $methods   = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $asTaskDef = $methods | Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1

    $tArg    = $asyncOp.GetType().GetGenericArguments()[0]
    $asTask  = $asTaskDef.MakeGenericMethod($tArg)
    $netTask = $asTask.Invoke($null, @($asyncOp))
    $netTask.GetAwaiter().GetResult()
  }

  # ------------------------------------------------------------------
  # 3. Load WinRT ink types via the ContentType=WindowsRuntime trick
  # ------------------------------------------------------------------
  $null = [Windows.UI.Input.Inking.InkRecognizerContainer,  Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkStrokeBuilder,        Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkPoint,                Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.UI.Input.Inking.InkRecognitionTarget,    Windows.UI.Input.Inking, ContentType=WindowsRuntime]
  $null = [Windows.Foundation.Point,                        Windows.Foundation,       ContentType=WindowsRuntime]

  # ------------------------------------------------------------------
  # 4. Read stroke data from the temp file
  # ------------------------------------------------------------------
  $json      = Get-Content -Raw -LiteralPath $InputFile
  $strokeData = $json | ConvertFrom-Json

  if (-not $strokeData -or $strokeData.Count -eq 0) {
    Write-Output ''
    exit 0
  }

  # ------------------------------------------------------------------
  # 5. Build InkStroke objects from the normalized { x, y } points
  # ------------------------------------------------------------------
  $container  = [Windows.UI.Input.Inking.InkRecognizerContainer]::new()
  $builder    = [Windows.UI.Input.Inking.InkStrokeBuilder]::new()
  $identity   = [System.Numerics.Matrix3x2]::Identity

  # PowerShell generic list typed to the projected WinRT struct
  $strokeList = New-Object 'System.Collections.Generic.List[object]'

  foreach ($strokePts in $strokeData) {
    if ($strokePts.Count -lt 2) { continue }

    $inkPtList = New-Object 'System.Collections.Generic.List[object]'
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
  # 6. Run recognition (async → blocked via AsTask)
  # ------------------------------------------------------------------
  $asyncOp = $container.RecognizeAsync(
    $strokeList,
    [Windows.UI.Input.Inking.InkRecognitionTarget]::All
  )
  $results = Await-WinRT $asyncOp

  # ------------------------------------------------------------------
  # 7. Collect best candidate from each recognition result
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
  # Any failure is silently swallowed — the caller treats an empty
  # result as "not recognizable" rather than an error.
  Write-Output ''
  exit 0
}
