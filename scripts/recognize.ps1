<#
.SYNOPSIS
  Recognizes handwritten ink strokes using the Windows Ink API.

.DESCRIPTION
  Reads a JSON file whose path is passed as -InputFile.
  The JSON is an array of strokes; each stroke is an array of { x, y } objects.
  All coordinates are already normalized by the caller (bounding box starts at 0,0).

  Uses Windows.UI.Input.Inking.InkRecognizerContainer (built into Windows 10/11).
  Writes recognized text to stdout.
  Writes diagnostic information to stderr.

.PARAMETER InputFile
  Absolute path to the temporary JSON file written by the Node main process.

.NOTES
  WinRT async operations return System.__ComObject from PowerShell -- the
  IAsyncOperation<T> interface is not projected because the generic result type
  is unknown at call time. The fix: compile an inline C# helper via Add-Type
  that references the WinMD files directly. C# has proper WinRT type awareness
  and AsTask() works correctly inside compiled code.

  PowerShell is responsible only for reading the JSON and extracting raw
  coordinates as primitive double arrays. The C# helper does all WinRT work.
#>
param([string]$InputFile)

$ErrorActionPreference = 'Stop'

try {
  # ------------------------------------------------------------------
  # 1. Locate Windows WinMetadata directory and required assemblies.
  #    WinMD files contain the WinRT type definitions that C# needs.
  # ------------------------------------------------------------------
  $winmetaDir = Join-Path $env:SystemRoot 'System32\WinMetadata'

  $uiWinmd         = Join-Path $winmetaDir 'Windows.UI.winmd'
  $foundationWinmd = Join-Path $winmetaDir 'Windows.Foundation.winmd'

  if (-not (Test-Path $uiWinmd)) {
    throw "Windows.UI.winmd not found at: $uiWinmd"
  }
  if (-not (Test-Path $foundationWinmd)) {
    throw "Windows.Foundation.winmd not found at: $foundationWinmd"
  }

  # System.Runtime.WindowsRuntime.dll provides AsTask() extension method
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $winRTExtDll = [System.WindowsRuntimeSystemExtensions].Assembly.Location

  # System.Numerics.dll provides Matrix3x2
  Add-Type -AssemblyName System.Numerics
  $numericsDll = [System.Numerics.Matrix3x2].Assembly.Location

  # ------------------------------------------------------------------
  # 2. Compile inline C# helper.
  #    All WinRT types, stroke construction, and async recognition
  #    happen inside this compiled class -- no PowerShell WinRT interop.
  # ------------------------------------------------------------------
  if (-not ([System.Management.Automation.PSTypeName]'InkBridge').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.UI.Input.Inking;

/// <summary>
/// Builds InkStrokes from raw coordinate arrays and runs handwriting recognition.
/// Receives strokes as double[][] (each inner array is [x0,y0, x1,y1, ...]).
/// </summary>
public static class InkBridge {
    public static string[] Recognize(double[][] strokes) {
        var builder   = new InkStrokeBuilder();
        var container = new InkStrokeContainer();
        var identity  = new System.Numerics.Matrix3x2(1, 0, 0, 1, 0, 0);
        var strokeList = new List<InkStroke>();

        foreach (var coords in strokes) {
            if (coords.Length < 4) continue;  // need >= 2 points (4 coords)
            var inkPoints = new List<InkPoint>();
            for (int i = 0; i + 1 < coords.Length; i += 2) {
                var pt  = new Windows.Foundation.Point(coords[i], coords[i + 1]);
                inkPoints.Add(new InkPoint(pt, 0.5f));
            }
            if (inkPoints.Count >= 2) {
                strokeList.Add(builder.CreateStrokeFromInkPoints(inkPoints, identity));
            }
        }

        container.AddStrokes(strokeList);

        var rc      = new InkRecognizerContainer();
        var results = rc.RecognizeAsync(container, InkRecognitionTarget.All)
                        .AsTask().GetAwaiter().GetResult();

        var words = new List<string>();
        foreach (var r in results) {
            var candidates = r.GetTextCandidates();
            if (candidates.Count > 0) words.Add(candidates[0]);
        }
        return words.ToArray();
    }

    public static int GetRecognizerCount() {
        return new InkRecognizerContainer().GetRecognizers().Count;
    }

    public static string GetFirstRecognizerName() {
        var recs = new InkRecognizerContainer().GetRecognizers();
        return recs.Count > 0 ? recs[0].Name : "(none)";
    }
}
'@ -ReferencedAssemblies @(
      $uiWinmd,
      $foundationWinmd,
      $winRTExtDll,
      $numericsDll
    ) -ErrorAction Stop
  }

  # ------------------------------------------------------------------
  # 3. Verify at least one handwriting recognizer is installed
  # ------------------------------------------------------------------
  $recCount = [InkBridge]::GetRecognizerCount()
  if ($recCount -eq 0) {
    [Console]::Error.WriteLine('No handwriting recognizers found. Install a Windows handwriting language pack.')
    Write-Output ''
    exit 0
  }
  [Console]::Error.WriteLine("Recognizers available: $recCount, first: $([InkBridge]::GetFirstRecognizerName())")

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
  # 5. Convert stroke objects to double[][] for the C# helper.
  #    Each stroke becomes a flat array [x0,y0, x1,y1, ...].
  # ------------------------------------------------------------------
  $strokeArrays = [System.Collections.Generic.List[double[]]]::new()

  foreach ($strokePts in $strokeData) {
    if ($strokePts.Count -lt 2) { continue }
    $coords = [double[]]::new($strokePts.Count * 2)
    for ($i = 0; $i -lt $strokePts.Count; $i++) {
      $coords[$i * 2]     = [double]$strokePts[$i].x
      $coords[$i * 2 + 1] = [double]$strokePts[$i].y
    }
    $strokeArrays.Add($coords)
  }

  [Console]::Error.WriteLine("Stroke arrays built: $($strokeArrays.Count)")

  if ($strokeArrays.Count -eq 0) {
    Write-Output ''
    exit 0
  }

  # ------------------------------------------------------------------
  # 6. Run recognition via C# helper
  # ------------------------------------------------------------------
  $words = [InkBridge]::Recognize($strokeArrays.ToArray())
  [Console]::Error.WriteLine("Recognition results: $($words.Length)")

  $text = $words -join ' '
  [Console]::Error.WriteLine("Recognized: '$text'")
  Write-Output $text

} catch {
  [Console]::Error.WriteLine("recognize.ps1 error: $($_.Exception.Message)")
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  Write-Output ''
  exit 1
}
