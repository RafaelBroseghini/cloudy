# Thunder sound credits

All three files are excerpts from public-domain recordings on Wikimedia Commons (licence shown as "Public domain": Commons `LicenseShortName` = "Public domain", `License` = `pd`). No attribution is legally required; credit is given anyway.

Common processing for all three: mono, 44.1 kHz, MP3 96 kbps, 12 s excerpt, 5 ms fade-in, 1.5 s fade-out (starts at 10.5 s). Chain: peak limiter (limit 0.6, attack 0.5 ms, release 60 ms), silenceremove (-45 dB), atrim to 12 s, loudnorm (I=-18, TP=-2, two-pass measurement; ffmpeg reported Dynamic normalisation mode, not linear), then a final peak limiter for true-peak headroom. Measured values below are from decoding the final MP3s. Encoded length is 12.04 s because of MP3 encoder padding.

## thunder-1.mp3

- Original title: Storm thunderbolts.ogg
- Commons file page: https://commons.wikimedia.org/wiki/File:Storm_thunderbolts.ogg
- Author: stephan (Commons Artist field). The description also says the recording was made by "Jc" Guan for LibriVox (May 2007) and uploaded in his name. It is PDSounds record 301.
- Licence: Public domain
- Processing: excerpt 88.454 s to 100.454 s of the 5:02 source. The crack starts at 88.469 s in the source, so it lands about 25 ms into the clip. Final-stage peak limiter at 0.68. Measured: -20.0 LUFS integrated, -2.7 dBFS true peak, LRA 4.1 LU.

## thunder-2.mp3

- Original title: Tonitrus.ogg
- Commons file page: https://commons.wikimedia.org/wiki/File:Tonitrus.ogg
- Author: Mysid (Commons Artist field). Description: "Thunder recorded in Southern Finland."
- Licence: Public domain
- Processing: excerpt 14.00 s to 26.00 s of the 32 s source. It starts mid-roll, so there is no leading silence to trim. The source is stereo and was downmixed to mono at the start of the chain (aformat), before the limiter and loudnorm. Final-stage peak limiter at 0.75. Measured: -19.5 LUFS integrated, -2.9 dBFS true peak, LRA 3.1 LU.

## thunder-3.mp3

- Original title: Rain and thunder.ogg
- Commons file page: https://commons.wikimedia.org/wiki/File:Rain_and_thunder.ogg
- Author: User:Caesar (Commons Artist field). Description: "Recording of rain and thunder."
- Licence: Public domain
- Processing: excerpt 2.93 s to 14.93 s of the 18.9 s source. The louder burst is at about 2.95 s in the source, so it lands about 20 ms into the clip. Final-stage peak limiter at 0.75. Measured: -18.7 LUFS integrated, -2.6 dBFS true peak, LRA 5.1 LU.
