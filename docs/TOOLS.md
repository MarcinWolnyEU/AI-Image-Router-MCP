# Tool reference

The README lists the tools in one table. This page has the parameters, output shapes and behavior notes.

Every media-returning tool takes `output_mode`: `filePath` (default) saves the file and returns its path, `base64` also saves it but returns the bytes inline too. Video in base64 is large.

Generation tools (`generate_image`, `image_to_video` in `mp4` mode, `generate_video`) accept a `provider_options` object that passes gateway or model specific fields straight through. Examples: OpenRouter `image_config`, MiniMax `prompt_optimizer` and camera commands, Veo `generate_audio`. Mistral's image tool takes none, so they are ignored there and the reply says so. A note such as `Note: ... generated WITHOUT: resolution, fps` tells you when a request had to be adapted.

## `generate_image`

Generates images from a prompt, saves them to the output folder and returns the path plus an inline preview.

- **Size.** `width` (pixels) is the main lever. `height` is derived from `width` and `aspect_ratio` (default `1:1`) unless you pass it. Gateways whose models accept exact pixel sizes (fal's object `image_size`) honor width and height directly. Others map to the nearest tier. A lone `height` derives the width from the aspect ratio. When a model returns a different size than requested, the reply says so (`Note: requested W×H, but <model> returned A×B`).
- **`n`.** Images per call, offered wherever the model advertises it (Eden, and OpenRouter models such as gpt-image-1-mini).
- **Async.** `wait: false` submits the job and returns a `job_id` immediately, so a slow generation never trips a client timeout. Call the tool again with that `job_id` to poll. The provider's own request id (fal `request_id`) shows up once the job is running. The result is saved as soon as the job finishes, even if you never poll, and every poll of a finished job returns the same files. Polling never writes duplicates and never re-runs Tinify. A failed job reports the same possible-cause hints as a blocking call.
- **Reference images.** Where the model supports them (OpenRouter `input_references`, fal Krea `image_style_references`), pass `reference_images` as local paths, URLs or data URLs. Passing them to a model with no image-conditioning input fails before any API request, so no credit is spent. Every reference must resolve (URLs are downloaded to a local copy, content is checked by magic bytes) or the generation is refused.
- **`reference_mode`.** `subject` conditions on the object or geometry of the reference, `style` adopts its look and medium. A mode the configured model cannot provide is refused before generating, and the error names what the model does provide.
- **`output_format`.** `png`, `webp`, `jpg` or `avif` (these four need a Tinify token) or `ico` (see below).
- **Per-model options (OpenRouter).** The schema is built from the model's live `supported_parameters`. `quality` (for gpt-image-2.5: `auto`, `low`, `medium`, `high`, `xhigh`, `max`) appears only when the model has it. `image_size` disappears for a model with no resolution tier; gpt-image-2.5 renders at its native full size, which is stored as is, and a configured default tier is dropped with a note. The `background` description states the native modes (gpt-image-2.5: `auto` and `opaque` only). `transparent` is refused before generation, with a hint to generate on a flat colour and use `remove_background`. An explicit `width` and `height` go out as an exact `size`, and fall back to the native size if the provider rejects it as too small.
- **Reporting.** Every result line reports the image type, pixel size and bytes (`image/png 1536×1024 (862 KB)`). API failures come back explained: what the HTTP status means, the OpenRouter `error_type`, moderation reasons, the offending parameter, and possible-cause hints.

### Constraints

- `palette` pins the accent colours (a list of hex values). It is compiled into an exact-colour instruction plus "no <other hue families>", mapped to a native palette field where the model has one (fal Recraft `colors[]`), and the result is measured against it: the share of accent pixels on each colour and the dominant off-palette accent.
- `exclude` lists what must not appear ("text", "watermark", "cable"). Known terms are expanded to the phrasing that actually suppresses them and sent as the model's own `negative_prompt` where it has one.
- `background` takes `transparent`, a hex value, a colour word or free text. It is mapped natively where possible (OpenRouter `background`, fal Recraft `background_color`) and checked against the border of the result.

### `output_format: "ico"`

Wraps the generated image in a single-entry Windows `.ico` at `width`, a square size from `16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256` (default `256`). The render is square by default, so the configured default aspect ratio is not applied to icons. Pass `aspect_ratio` or `height` to render something else.

If the model supports exact pixels (fal object `image_size`), it renders `width` by `width` directly. Otherwise the model renders at a supported size at or above `width` and the result is downscaled to exactly `width` with a slight sharpen. It is never upscaled: a model output that is too small is an error, and a `width` outside the allowed sizes is rejected before generation. A non-square result is fitted whole onto the square canvas (`square_fit: "pad"`, the default, with `pad_color` setting the fill). `"crop"` opts into a centre crop and reports how much it dropped. The reply always states which was done. The untouched original is kept as `<name>-original.png`.

## `image_to_video`

Two modes, chosen by `output_format`.

- **`mp4`** (default) animates reference images with the configured model: a single image, first and last frame, or several references. Frames a model cannot take (fal sends one image) are refused before anything is billed. A video file passed as `image` is rejected. Needs an image-to-video model in the configuration.
- **`gif`** assembles supplied frames into an animated GIF locally, with no gateway and no cost. Frames come from `image` (first), `images_inner` (ordered middle frames) and `image_last` (at least two frames in total). `fps` is a number or an array with one value per frame. Other options: `loop`, `max_colors`, `optimize_palette`, `fit`, `width`, `height`. Transparency is 1-bit. With `optimize_palette` (default on) the encoder tries several palette sizes and picks the knee of the quality-versus-size curve. For photographic frames that can land low, so set `max_colors` or turn the option off to control it.

## `generate_video`

Generates a video from a text prompt. Async by default: poll with just `{ job_id }`, since `prompt` is only needed to submit. With a `model` override, the configured default resolution, fps and duration (chosen for the configured model) are not applied. The tool is registered only when the active gateway supports text to video.

## `remove_background`

Local background removal to a transparent PNG, with no gateway. Models: BiRefNet (general, massive), BRIA RMBG-2.0, IS-Net, BEN2, Finegrain box segmenter. The tool is offered unless the model is set to `none`. Inputs are checked by magic bytes, so a video passed as `image` is refused.

## `crop_media`

Crops an exact pixel region from an image (sharp `extract`) or a video (ffmpeg). The region is checked against the image bounds first.

## `transform_media`

One tool for the everyday conversions.

- **Downsize.** Pass `width` and/or `height`. Images use the Magic Kernel Sharp 2021 kernel and only ever shrink, fitting inside the box and keeping the aspect ratio.
- **Convert format.** `output_format` of `png`, `jpg`, `webp` or `avif`, through Tinify when a token is set and sharp otherwise.
- **Extract a still.** An image `output_format` on a video input samples a frame from 10% of the duration, stepping on past mostly black frames. Needs `ffprobe`.
- **Transcode.** `output_format: "mp4"` on a video produces H.264/AAC (an mp4 passes through). A video format on an image input is an error pointing at `image_to_video`.
- **Batch.** `image` accepts an array. Each item is processed on its own and `inline_preview` is forced off.
- **No-op.** With only `output_mode`, the file comes back unchanged.
- **`save: false`.** Writes nothing and returns inline previews when enabled, including when building an `.ico`.

### ICO with `transform_media`

With `output_format: "ico"` and an array of images, the tool builds a multi-size or merged icon. Each image must already be a square at an allowed ICO size (no resizing; use `generate_image` to downscale), existing `.ico` files are parsed and merged, and duplicate sizes are rejected.

Pass `sizes` to declare the set the icon must contain. The result must equal it exactly or the call fails and writes nothing. With one size per input, a file whose real dimensions differ from its declared slot is reported by name. Either way, every entry is listed with the input it came from. Use `build_icon_set` when you want the sizes derived instead of validated.

An ICO input with a non-ico image `output_format` unpacks every size into its own file named `<stem>-<WxH>.<ext>` (for example `favicon-256x256.png`). The stem is the source filename without its extension, or `icon` for a URL, data URL or base64 input. Existing files are never overwritten: if a name is taken, the whole set gets a numbered stem (`icon-2-48x48.png`). `width` and `height` are ignored when unpacking.

ICO inputs are read with the project's own decoder. It handles PNG-compressed entries (the 256 px entry in most modern favicons), 1, 4 and 8 bit paletted, 16, 24 and 32 bit bitmaps, and the AND transparency mask.

## `build_icon_set`

Builds a whole icon set in one verifiable operation. Every declared size is derived from the intended source by downscaling (never regenerated), written as its own exact `WxH` file, and assembled into a multi-size `.ico` that is checked to contain exactly the declared set.

`variants` points specific sizes at a simplified source, for example a mark without the wordmark for 16, 24 and 32, while those sizes stay part of the same set. Non-square sources are padded rather than cropped by default (`square_fit`). The reply lists every entry with its source. Duplicate, unknown or un-derivable sizes fail before anything is written, because every size is derived and the icon verified in memory first. A failure never leaves a partial set on disk. `ico: false` emits just the images.

## `health_status`

Reports the gateway, configured models and options, the background-removal execution provider, free RAM and VRAM, logging, the fal safety setting (fal only), the Tinify state, the HTTP transport state and any wizard-time or runtime errors.

## `restart`

Soft reload: re-reads `config.json`, re-initializes the gateway and the ONNX session, clears recorded errors, and keeps the connection alive. It is all or nothing. If the new configuration cannot be applied (a missing token file, for example), the previous configuration stays fully active and the error is reported. On success the tool list and option schemas are refreshed for the new gateway and model, and clients are notified through `tools/list_changed`.

## `shutdown`

Flushes logs and stops the process after a short delay, so the reply is delivered first.

## Generated media and previews

Files are written to the configured output directory (default `output/`, inside the data directory) with descriptive, timestamped names. A tool returns the absolute path as a `resource_link`, plus an inline preview for small images, downscaled automatically if needed. That keeps large videos out of the conversation while still handing you the file.

When a call fails, the result has `isError: true` and a text block describing what went wrong. Where the cause is an account or configuration issue that the gateway reports opaquely, the result may also include possible-cause hints, such as an OpenRouter provider on your Ignored Providers list, or a key with Include BYOK enabled while credit remains. Each hint is a text block that starts with `Possible cause:` and carries `_meta."ai-image-router/category" = "possibleCause"`, so it displays in any client and can be detected by code. They are best-effort guesses.

## Image compression and conversion (Tinify)

With a [Tinify](https://tinify.com/developers) token (default file `tinify com token.txt`, or set it in the wizard), `generate_image` can optimize its output through direct REST calls:

- `png` (default): the model is steered to PNG, the raw PNG is kept as `<name>-original.png`, and a Tinify-compressed PNG is saved as `<name>.png` and returned.
- `webp`, `jpg`, `avif`: the source PNG is kept as `<name>.png` and a Tinify-converted file is saved and returned. This always goes through Tinify, even for models that can emit those formats, because the files come out noticeably smaller (AVIF is usually the smallest).
- If Tinify fails, the original PNG is saved and a warning is included. A generation is never lost.

Typical results on a 1 MB generated PNG: compressed PNG about 46 to 64% smaller, WebP about 95% smaller.

## Media editing details

`crop_media` and `transform_media` take a file path, an http(s) URL, a data URL or raw base64, and work on both images and videos.

- Images use sharp. Video uses ffmpeg from your `PATH` (frame extraction also needs `ffprobe`, which ships with ffmpeg). Without ffmpeg, video operations return a clear message and image editing is unaffected.
- A PNG returned as base64 while Tinify is enabled is compressed first, and the uncompressed copy is kept as `-original`.
- Format conversion works without a Tinify token: sharp handles PNG, JPEG, WebP and AVIF locally, with larger files.
