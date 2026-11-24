# Third-party notices

## go-c2dmc

The extraction provenance follows [`syke99/go-c2dmc`](https://github.com/syke99/go-c2dmc), inspected at tree
`1474067bf9c75a4acc15990eb086846f23e025b5`. That repository is distributed under the MIT License.
The repository's runtime source URL is `https://floss.maxxmint.com/dmc_to_rgb.php`; this project uses only
the committed snapshot in `catalog/source/dmc_to_rgb.php` and does not fetch it at runtime.

The MIT attribution for go-c2dmc is preserved here as provenance for the source chain. The normalized data
is a screen-color approximation derived from an upstream HTML table. It is **not official DMC data**, is not
endorsed by or affiliated with DMC, and makes no claim of thread, dye, fabric, display, or colorimetric
accuracy. This project includes no DMC imagery or logos.

The upstream page's separate rights and attribution status is unresolved. Review its terms before
redistribution or commercial use; the notice above is not a determination that the upstream color/name data
is freely redistributable.

### MIT License notice

Copyright (c) syke99

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.

## Mill Hill DMC to Glass Bead Conversion

`catalog/source/mill-hill-dmc-conversion.csv` is a hand transcription of Mill Hill's "DMC to Glass Bead
Conversion" chart (Product #CCB, Wichelt Imports, Inc., updated 2010), retrieved on 2026-11-04 from
`http://www.millhillbeads.com/images/bead_to_dmc_conversion.pdf` (SHA-256
`2d81ef8097848ea344aba5040338db08b0954cd2e5a461265ac0b7932ff15852`). The application reads only the
committed `catalog/mill-hill-beads.json` built from it and never fetches the chart.

Each bead's colour is the screen approximation of the DMC thread the chart maps it to, taken from the DMC
catalog above. It is **not official Mill Hill data**, is not a measurement of any bead, and is not endorsed
by or affiliated with Mill Hill or Wichelt Imports. Mill Hill notes that the mapping can vary with dye lots.
This project includes no Mill Hill imagery or logos.

The chart's rights and attribution status is unresolved. Review Mill Hill's terms before redistribution or
commercial use.
