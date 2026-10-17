# Phone-first attachment and shared-link research for Pico

**Research date: 17 October 2026.** Public documentation and repository review; not an implementation or a live integration certification.

## Executive recommendation

Make Telegram a **personal capture inbox**, not just a URL bookmark collection. For each thing shared, Pico should preserve the supplied source, recover the content it can legitimately access, explain missing parts, and make the useful result searchable with citations. It must distinguish **“I saved the link,” “I read the text,” “I transcribed the audio,” and “I understood the visuals.”** Those are different outcomes.

For the four examples that motivated this research:

| You share | Useful basic handling | Useful advanced handling | The important catch |
| --- | --- | --- | --- |
| YouTube link | Save video identity, your note, timestamp, and an accessible, permitted transcript or excerpt. | Timestamped transcript, chapter summaries, selected frame OCR/description, and source-linked recipes, procedures or ideas. | The official captions download API requires permission to edit the video. A public video, YouTube Premium, an embed, or an API key does not grant general download/transcription rights. |
| Instagram post | Preserve URL and your note; read supplied caption/screenshots/images. | Ordered carousel OCR, image descriptions, structured extraction, linked external source. | Instagram oEmbed is for display, **not an extraction/persistence backend**. Official account APIs are not a universal reader for arbitrary personal accounts. |
| Instagram Reel | Preserve URL; use a legally supplied video/audio/transcript when the link is inaccessible. | Speech transcription **plus** on-screen-text OCR and selected frame analysis. | Speech alone misses silent instructions, ingredients, demonstrations and text overlays. Do not promise reliable link-only extraction. |
| Reddit post | Preserve post/permalink and supplied text; separate the post, comments and linked article. | Permissioned bounded thread retrieval, comment ancestry, edits, media, and externally checked claims. | API access and permitted AI/retention use need review; adding `.json` is not a guaranteed or permission-free integration. |

**Recommended build order:** improve the common file/media pipeline first; add safe public-page capture; add authorized video/podcast transcription; then add a small number of justified account integrations. Do not build a separate downloader for every app.

This document is intentionally much broader than Pico's shipped features. **“Basic” and “advanced” below are proposed handling levels, not assertions that Pico already implements them.** Current behavior is isolated in [section 3](#3-what-pico-can-actually-do-today).

## Contents

1. [Scope, research method and evidence](#1-scope-research-method-and-evidence)
2. [What sharing from a phone actually delivers](#2-what-sharing-from-a-phone-actually-delivers)
3. [What Pico can actually do today](#3-what-pico-can-actually-do-today)
4. [Attachment taxonomy: formats, objects and edge cases](#4-attachment-taxonomy-formats-objects-and-edge-cases)
5. [Reusable basic and advanced processing recipes](#5-reusable-basic-and-advanced-processing-recipes)
6. [Social, video and audio apps](#6-social-video-and-audio-apps)
7. [Messaging, email and meetings](#7-messaging-email-and-meetings)
8. [Browsers, news, newsletters and read-later apps](#8-browsers-news-newsletters-and-read-later-apps)
9. [Cloud storage, office, notes and design](#9-cloud-storage-office-notes-and-design)
10. [Research, development and learning](#10-research-development-and-learning)
11. [Maps, travel, events and local places](#11-maps-travel-events-and-local-places)
12. [Shopping, food, homes and money](#12-shopping-food-homes-and-money)
13. [Books, entertainment, fitness and personal records](#13-books-entertainment-fitness-and-personal-records)
14. [Regional, specialist and long-tail apps](#14-regional-specialist-and-long-tail-apps)
15. [What to remember, what merely to retain, and how to reply](#15-what-to-remember-what-merely-to-retain-and-how-to-reply)
16. [Implementation plan and tool choices](#16-implementation-plan-and-tool-choices)
17. [Security, privacy, rights and operational failures](#17-security-privacy-rights-and-operational-failures)
18. [Acceptance checklist and test corpus](#18-acceptance-checklist-and-test-corpus)
19. [Sources and access limitations](#19-sources-and-access-limitations)

## 1. Scope, research method and evidence

### What “exhaustive” can honestly mean

There is no finite list of every possible attachment: an app can share an arbitrary binary, a new proprietary format, a new URL scheme, or a combination of existing objects. Share behavior also changes by OS, app version, region, login state and subscription.

The useful exhaustive approach is therefore:

- Cover the **transport forms**: text, links, bytes, structured objects, forwards and bundles.
- Cover the **content families**: text, images, documents, tables, audio, video, location, events, contacts, archives, app records and opaque binaries.
- Inventory major apps and their materially different object types, including inaccessible/private/expired content.
- Define a fallback for **every unknown source** rather than pretending every site has a dependable extractor.
- Track content coverage and rights **per component**, not just per URL or file extension.

The catalog includes some desktop-origin formats because they routinely reach a phone through email, Files, Drive or chat.

### Research performed

- Started with `README.md`, channel/document/security/testing/feature documentation, and the relevant Telegram/media source code in this repository.
- Requested public platform docs, API references, standards and maintained tool documentation directly over HTTPS. No owner accounts, credentials, browser profiles, private messages or deployed instances were inspected.
- Reviewed the key API and policy constraints, especially YouTube captions/downloads, Instagram API/oEmbed restrictions, Reddit data use, Spotify AI ingestion, Telegram file transfer, podcast transcripts and authenticated document export.
- Used small public oEmbed examples to check the **shape** of YouTube/X embed responses. That does not test video access, transcription, thread completeness, Pico delivery or permission to process their content.
- Some documentation URLs failed, redirected to unrelated material, or returned only JavaScript shells. These are explicitly recorded below; HTTP 200 was **not** treated as proof that a feature exists.

**Evidence labels used in the catalog:**

- **Documented:** the cited first-party documentation supports the described interface or restriction, not a working Pico integration.
- **Tool-dependent:** a maintained third-party tool may handle it; actual support must be tested with an authorized example.
- **Export-first:** a supplied file, selected text or screenshot is the dependable starting point.
- **Proposal:** a desired processing/product behavior, not an assertion about an app API.

The app tables are design recommendations. Where no app-specific first-party reference was readable, use them as **export-first proposals**, not as claims of verified automated access. This is technical research, not legal advice; licensing and platform terms require use-case-specific review before deployment.

## 2. What sharing from a phone actually delivers

A Telegram bot does not receive the source app's entire internal object. The share sheet may send only a URL, only a preview image, selected text, a copied file, or several messages. The bot cannot inspect the originating app, read its logged-in session or infer that missing content is accessible.

| Transport form | Examples | What intake should preserve | What not to assume |
| --- | --- | --- | --- |
| Plain text | Copied caption, selected passage, shopping note | Exact text, owner commentary, receipt time; original URL if supplied | It is complete, authored by the owner, or an instruction rather than quoted evidence |
| Visible URL | YouTube, Reddit, product, article | Original URL, normalized identity, fragment/timestamp, your note | The page or media has been fetched |
| Hidden URL entity | A linked word in a Telegram message/caption | Both display text and actual destination | Display text identifies the destination honestly |
| Multiple URLs | Thread with source links; recipe and ingredient shop | Order and their relation to supplied text | Every link should be recursively opened |
| Photo | Camera photo, screenshot, compressed share image | Received bytes, dimensions, caption, sequence | Telegram preserved the camera original, EXIF, full resolution or original filename |
| Image as document | Original PNG, HEIC, JPEG, scan | Exact received bytes and verified type | The processor supports that codec |
| Audio/voice | Voice note, recording, podcast excerpt | Original, duration when probed, caption, language/transcript provenance | Every audio upload is recognized by the same Telegram media field |
| Video/video note | Reel export, screen recording, camera clip | Original, stream metadata, orientation, caption | The model watched it or audio was extracted |
| Animation/sticker | GIF, animated WebP, TGS, WebM sticker | Original, type, supplied emoji/label | A first frame represents the animation or that it contains useful speech |
| Generic document | PDF, DOCX, CSV, ZIP, opaque binary | Bytes, hash, name, detected/declared type, limits | A nice filename proves safe or supported content |
| Album/media burst | Carousel screenshots, receipt pages | Ordered item membership and every caption; explicit gaps | The platform delivered all items or the original post's order is recoverable |
| Forwarded message | Channel post, another person's voice note | Available forward origin, supplied text, message IDs/time | Forwarded author identity is verified or their instructions are the owner's |
| Reply/quote | “Remember this bit” replying to a post | Owner's instruction separately from quoted evidence | Reply context includes all original attachments or the whole thread |
| Location/live location | Pin, coordinates, temporary live share | Coordinates, accuracy/time/expiry if supplied | It is the owner's current position or a durable tracking subscription |
| Venue/contact/poll/dice | Restaurant, business card, poll result | Native structured fields with labels | A contact is the owner, a poll has every vote, or a dice result authorizes an action |
| App-only deep link | `notion:`, `obsidian:`, `strava:`, bank/app schemes | Inert original link and human-visible context | The daemon can open the app or should execute a URI handler |
| Cloud/capability link | Private Drive item, signed PDF, private podcast feed | Private source reference; redact secret query/path tokens in logs | “Anyone with the link” is public or safe to send to a search provider |
| Bundle/export | ZIP of notes, HTML plus assets, chat export | Manifest, selected import scope, nested provenance | Everything in the archive should be imported or executed |
| Missing/unsupported reference | Story, expired download, paid preview, removed post | Supplied reference and honest unavailable outcome | Thumbnail, title or cached snippet reconstructs the missing body |

**Phone UX recommendation:** sharing the link plus one short instruction should be enough: “save for later,” “remember this recipe,” “what matters here?”, “compare these,” or “remind me Friday.” A caption-less share can go to an explicitly opted-in capture inbox; it must not silently become a belief, personal preference, reminder or account subscription.

Android describes `ACTION_SEND`/`ACTION_SEND_MULTIPLE` and MIME-based sharing; Apple share extensions receive selected extension items, not arbitrary access to another app. Web Share likewise transfers explicitly supplied data. A custom Pico share extension is optional future work, **not necessary for the first Telegram workflow**. [ANDROID-SHARE] [APPLE-SHARE-EXT] [WEB-SHARE]

## 3. What Pico can actually do today

Repository-inspected baseline; no live Telegram or model test was performed for this research.

| Area | Shipped behavior | Gap relative to the proposed inbox |
| --- | --- | --- |
| Telegram identity | Private allowlisted owner senders; authorization before download/storage; forwarded content stays evidence | Do not add third parties to the owner allowlist just to collect their files |
| Links | Text/caption/hidden destinations and reply/quote context preserved | URLs are **not automatically fetched on receipt**; no universal social-app resolver |
| Public web | Bounded public HTML/text/Markdown fetch, readable extraction, captured sources; explicit durable save | No JavaScript browser, ambient cookies, general binary/media download, or authenticated page scraping |
| Photos/images | Received originals retained; PNG/JPEG/GIF/WebP can receive a configured vision-model description/visible-text transcription | Description is fallible; no universal OCR guarantee, HEIC/RAW promise, video-frame analysis or scanned-PDF OCR |
| Office/text documents | Local AnyDoc/native conversion for documented formats; preserved originals, revisions and citations | Complex layout, editorial changes, original PDF coordinates, cached spreadsheet values and OCR have explicit limits |
| Voice/audio | Recognized incoming **voice/audio fields** can invoke separately enabled OpenAI transcription | An audio file arriving as a generic document is not necessarily auto-transcribed; no local-ASR backend, full diarization/timestamp pipeline or URL-audio fetch is established |
| Video/animation | Originals retained where accepted | No automatic stream probing, speech extraction, frame sampling or video understanding |
| Albums/bursts | Consecutive media combined into ordered agent input with supplied captions | No recovery of unseen carousel items or guaranteed source-app album identity |
| Structured shares | Contact/location/venue/poll/dice supplied as labelled evidence | No native event/contact/payment actions inferred from receipt |
| Stories/paid content | References/unsupported outcomes; no purchase/unlock | No story capture, DRM removal, secret-chat support or paid-media access |
| Retention/search | Durable incoming knowledge originals; source-linked representations and forgetting | Media-cache expiry is not deletion of durable knowledge; a saved link is not a saved source body |
| Credentials | Explicit private-vault setup; no borrowed ambient login | This research does not configure accounts or enable services |
| Google | Optional scoped Gmail/Docs/Drive/Sheets/Calendar/Contacts/Tasks services | Not universal Google-account access; remote writes remain separately consented and exact-terminal-approved |

Relevant implementation: [`src/features/telegram-input.ts`](../src/features/telegram-input.ts), [`src/features/telegram-channel.ts`](../src/features/telegram-channel.ts), [`src/media.ts`](../src/media.ts), [`src/features/web.ts`](../src/features/web.ts). Product contracts: [channels](CHANNELS.md), [documents](KNOWLEDGE.md), [web](FEATURES.md#web-search-and-research), [setup](SETUP.md#voice-transcription), [Google](GOOGLE.md), [security](SECURITY.md).

**Size distinction:** Pico documents a maximum **20 MB incoming attachment**, also bounded by configuration and Telegram availability. Telegram's hosted Bot API `getFile` limit is separate from what Telegram users can upload in their own chats. A local Bot API server can download without the hosted size limit and supports uploads up to 2000 MB, but **Pico has not thereby gained a local-server integration or higher safe processing limits**. Making that change would require explicit implementation and operations work. [TG-API] [TG-FAQ]

## 4. Attachment taxonomy: formats, objects and edge cases

These are possible inputs, not a support matrix for the present implementation. MIME detection, container inspection and resource limits must precede conversion; extension alone is insufficient.

### 4.1 Text, documents, tables and publications

| Family / representative formats | Basic treatment | Advanced treatment / important limits |
| --- | --- | --- |
| Plain text: TXT, LOG, UTF-8/UTF-16 text | Decode safely; preserve text and encoding | Language detection, structure/sections, exact quotations; never treat logs as commands |
| Markdown: MD, Markdown exports | Parse readable text and links | Preserve frontmatter, task lists, tables, embedded attachments, relative paths; render without active HTML |
| Rich text: RTF, rich clipboard, HTML fragment | Extract visible text | Preserve lists, links and formatting; embedded OLE/objects remain non-executable |
| HTML/HTM/XHTML | Readability extraction plus original capture | Main-content vs comments, pagination and canonical URL; no automatic script, form submission or external-resource loading |
| Web archives: MHTML/MHT, WARC, saved page ZIP | Preserve; extract selected textual resources | Resolve local assets under bounded paths; retain request/date provenance; never replay captured active content by default |
| JSON/JSONL/NDJSON, XML, YAML, TOML, INI | Bounded parse or text view | Schema-aware record extraction; distinguish data from config instructions; XML external entities disabled |
| CSV/TSV/delimited text | Show headers and sampled rows; preserve file | Correct dialect/encoding/quoting, types, units, row lineage, complete counts; escape spreadsheet formula injection on output |
| Spreadsheet: XLSX/XLS/XLSM/XLSB/ODS/NUMBERS | Extract available sheets and cached values | Formulas, named ranges, charts, merged cells, hidden rows/sheets and external links need explicit coverage; no macro execution or claim of recalculation |
| Word processing: DOCX/DOC/DOCM/ODT/PAGES | Extract text, headings, lists | Comments, revisions, tables, notes and assets; distinguish accepted text from tracked proposed changes |
| Presentations: PPTX/PPT/PPTM/PPSX/ODP/KEY | Slide text, order, available notes | Slide rendering, OCR, charts/diagrams and presenter notes; visual reading order may differ from XML order |
| Digital PDF | Extract text and metadata; preserve original | Page-level layout, tables, footnotes, annotations, forms, citations and mixed columns; verify extraction against rendered pages |
| Scanned/mixed PDF; PDF portfolio | Detect image-only or mixed pages; keep original | Selective page OCR, rotation/deskew, handwriting, per-page coverage; embedded portfolio documents handled separately |
| PDF/A, signed PDF, fillable PDF | Preserve bytes and readable content | Signature validation is a separate cryptographic check; conversion breaks signature equivalence; never sign or submit forms implicitly |
| Encrypted PDF/Office | Report locked state; preserve only as permitted | Password through a private non-chat secret flow; no cracking or persistent plaintext password |
| EPUB/FB2/HTML ebooks | Extract accessible chapters and metadata | Spine order, notes, images and locators; no DRM removal; scanned books use OCR pipeline |
| MOBI/AZW/AZW3/KFX and proprietary ebooks | Preserve if accepted; prefer authorized EPUB/text export | Format/DRM limitations; do not promise a Kindle decryptor |
| Comics: CBZ/CBR/CB7, manga/PDF | Preserve; bounded image enumeration if supported | Ordered page OCR and visual narrative with page citations; archive protections apply |
| LaTeX/BibTeX/RIS/CSL JSON | Read source/bibliography as data | Resolve bibliographic identifiers; never compile arbitrary TeX without a real isolated policy |
| Email: EML/MIME, MSG, MBOX | Extract selected headers, plain/HTML body and attachment manifest | Thread reconstruction, nested messages, DKIM context if available; sender display name is not authentication |
| Captions: VTT/SRT/TTML/SBV/ASS/SSA | Parse timed text, preserve language | De-overlap rolling captions, speaker labels, alignment, translated vs original track; no player-script execution |
| Forms/surveys/exported answers | Preserve questions, choices and submitted answers | Response IDs, branching, aggregates and privacy; do not submit a response by opening the link |
| Databases/datasets: SQLite, Parquet, Arrow, Avro, HDF5, NetCDF | Opaque preservation or bounded metadata preview | Read-only specialized query adapter, schemas/units and row/cell provenance; not “load the entire database into chat” |

### 4.2 Images, audio and video

| Family / representative formats | Basic treatment | Advanced treatment / important limits |
| --- | --- | --- |
| Photos/screenshots: JPEG, PNG, WebP, GIF | Preserve received pixels; caption/visible text and description | OCR boxes, UI region selection, multi-screenshot stitching with duplicate detection; distinguish photographed text from verified facts |
| HEIC/HEIF, AVIF, TIFF, BMP, JPEG XL | Detect and preserve; normalize only through supported bounded decoder | Multi-image/page containers, color profiles and transparency; retain original and conversion lineage |
| RAW: DNG/CR2/NEF/ARW and similar | Preserve opaque or use supported preview | Calibrated render/metadata; never claim sensor data is understood from a thumbnail |
| SVG/vector image, EPS/PS/AI | Inert text/metadata or safe raster preview | Disable scripts, links and external entities; PostScript is executable, so do not casually invoke an unrestricted interpreter |
| Layered artwork: PSD/PSB/KRA/PROCREATE/AFPHOTO | Preserve; use a supported composite preview | Specialized layers/text/canvas reader when justified; no app automation or plugin execution; composite may omit hidden layers |
| HEIC Live Photo / Motion Photo pairs | Preserve photo/video components when actually supplied | Associate still and motion/time metadata; Telegram may deliver only one component |
| Panoramas, 360°, stereo/depth images | Preserve and identify | Specialized projections, depth-aware interpretation and selected views; ordinary vision descriptions are incomplete |
| QR/barcodes: QR, EAN/UPC, Code 128, PDF417, Aztec | Decode as data, show type and destination | Resolve product/ticket identity only if permitted; never auto-open payment/login/Wi-Fi/OTP payloads |
| Animated GIF/WebP/APNG | Preserve and flag animation | Sample changed frames, OCR and timing; first-frame-only coverage explicitly labelled |
| Telegram stickers: WebP/TGS/WebM | Preserve and label | Optional safe preview/animation summary; do not inflate arbitrary Lottie/TGS content without bounds |
| Voice notes: Ogg/Opus, M4A/AAC | Retain and transcribe through an enabled permitted service | Original-language transcript, timestamps, code-switching and low-confidence markers; voice is not identity or authority |
| Audio files: MP3/WAV/FLAC/AIFF/ALAC/AMR/WMA | Probe supported streams and transcribe speech where permitted | Channel separation, noise handling, speaker diarization, segment retrieval and exact clips; codec support differs by backend |
| Music notation/project: MIDI/MusicXML/MXL/MSCZ/GP files, DAW projects | Preserve and inspect supported metadata/score preview | Specialized symbolic notes/tempo/instruments or score OCR; do not load project plugins, sample paths or executable instruments |
| Music, songs, instrument recordings | Preserve link/file and supplied context | Rights-permitted identification/structure; lyrics and copyrighted recording analysis have additional licensing constraints |
| Podcasts/audiobooks | Metadata and available publisher transcript | Chapter/segment transcription and bookmarks; dynamic ads can invalidate cross-platform timestamps; audiobook DRM remains out of scope |
| Video: MP4/MOV/WebM/MKV/AVI/MPEG/3GP | Preserve; bounded stream probe | Extract speech, subtitles, keyframes, scene-change OCR and time-aligned multimodal summaries; container does not prove supported codecs |
| Screen recording/tutorial/demo | Preserve with device context | OCR UI changes, transcribe steps, retain temporal order and prerequisites; credentials/notifications may appear in frames |
| Silent/ambient/security video | Explicitly note missing speech | Event/frame analysis if justified; no invented transcript or identification of people |
| Video note/round video | Preserve received original | Same video pipeline with crop/orientation context; circular preview may hide pixels |
| HLS/DASH manifests, livestream URLs | Keep link and available metadata | Only authorized bounded stream capture with segment/domain checks; a manifest is not the recording, and DRM/protected streams stay unsupported |
| Subtitle file plus media / alternate audio | Link supplied assets, retain each | Correct track/language/version selection and offsets; never merge translations as if they were verbatim speech |

### 4.3 Structured, sensitive and executable objects

| Family / representative formats | Basic treatment | Advanced treatment / important limits |
| --- | --- | --- |
| Location/venue, `geo:` links | Coordinates/place label and source time | Place-ID resolution, map preview and nearby context with permission; do not infer home/work automatically |
| Routes/tracks: GPX/KML/KMZ/GeoJSON/FIT/TCX | Route metadata and bounded point preview | Elevation/distance/segments and map rendering; location trails can reveal home, health and routines |
| Geographic datasets: Shapefile bundles, GeoPackage, GeoTIFF | Preserve manifest, coordinate system and bounded metadata | Specialized selected-layer reader; projection/axis order and raster scale matter; sidecars are part of the dataset |
| Calendar: ICS/iCalendar, event URL, `.ics` subscription | Read title, start/end, timezone and source | Recurrence/exceptions/cancellations/versioning; importing a file is not accepting an invitation or subscribing |
| Contacts: VCF/vCard, shared contact, address book export | Extract selected name/contact fields | Deduplication and company/person disambiguation; do not sync an address book or contact anyone implicitly |
| Tickets/passes: PDF/image/PKPASS | Extract human-readable event/travel details | Parse manifest and barcode without exposing redeemable secrets; pass signature verification is separate; no redemption/check-in |
| Receipts/invoices: PDF/image/XML/UBL/Factur-X | Merchant, date, amount, currency, line items when visible | Tax totals, returns, warranty/due dates and reconciliation; OCR errors in money require special caution |
| Financial statements: CSV/OFX/QFX/QIF/CAMT | Preserve and extract selected transactions | Read-only reconciliation, signed amounts, timezone/currency and recurring-charge proposals; never make payments |
| IDs, passports, licenses, certificates | Sensitive handling; preserve only with explicit need | Field OCR/minimization, expiry notices on request; not identity verification or a government-record lookup |
| Medical/lab records: PDF/images/HL7/FHIR/DICOM | Sensitive retention, source/units/reference ranges | Specialized structure and trends; DICOM may contain identifying metadata; no diagnosis from generic extraction |
| Archives: ZIP/TAR/GZ/BZ2/XZ/7Z/RAR | Preserve and bounded manifest | Selected extraction with traversal/symlink/bomb protection; archive support does not imply support for every member |
| Directory/bundle: photos+JSON, HTML+assets, sidecars | Preserve manifest and file relationships | Import only selected scope; distinguish originals, metadata, thumbnails and duplicates |
| Source code/notebooks: TS/PY/SH/IPYNB etc. | Read as inert text | Static explanation and dependency/source lineage; never execute code, notebook cells or install packages because they were attached |
| Binaries/installers: EXE/APK/IPA/DMG/PKG/DEB/WASM | Quarantine/opaque preservation or explicit rejection | Optional bounded static metadata/antivirus; **not execution**, device installation or “safe” certification |
| 3D/CAD/AR: STL/OBJ/STEP/GLTF/USDZ/3MF/BLEND/DWG | Preserve and metadata/thumbnail if supported | Specialized measurements/rendering with units and bounded parsers; plugins/scripts disabled; G-code or device-control output remains inert |
| Fonts, presets, profiles, configuration | Inert preview/manifest | Validate a known schema only; no installing fonts, VPN/cert profiles, browser extensions or automation rules |
| Cryptographic/capability objects: PEM/P12/KEY/KDBX, OTP QR, wallet seed | Detect sensitivity, do not index or send to an LLM by default | Dedicated private vault/import workflow if ever supported; no secrets in chat/history/research fixtures |
| Links to actions: `mailto:`, `tel:`, `sms:`, payment/deep links | Store/display inertly with scheme label | Explicit separate owner action required; no network fetch of arbitrary schemes |
| Native Telegram service/business/game/payment/story objects | Label the received reference and actual availability | Adapter-specific future work only; never infer a generic document exists behind every native object |
| Unknown or malformed binary | Honest unsupported outcome; preserve only within policy | Add a specialized reader only when repeated need justifies it; no silent guessed text |

Standards and reader references: [WEBVTT], [ICAL], [VCARD], [GEOJSON], [EMAIL], [EPUB], [WARC], [DICOM], [PDF], [EXIFTOOL], [ZIP]. These references describe formats/tools, not current Pico support.

## 5. Reusable basic and advanced processing recipes

Use these across apps. “Advanced” should be selected because it adds missing information, not because every attachment deserves maximum processing.

### A. Public web page / article

**Basic:** validate URL and every redirect; fetch bounded public HTML; extract title, author, publication/update date, main text and canonical URL; retain a capture and the owner's annotation. Mark previews, paywalls, truncation and missing images/comments.

**Advanced:** preserve readable structured sections, tables, recipe/product/event schema, selected image OCR, authorized next pages, and version differences. Follow only a small number of relevant links. A browser-rendered path is optional and isolated, never the default escalation when a site blocks access.

**Fallback:** selected text, print-to-PDF, reader export or screenshots. Do not call search snippets the full article. JSON-LD and Open Graph are useful hints, not guaranteed accurate bodies or permission grants. [JSONLD] [READABILITY] [TRAFILATURA]

### B. Social post / discussion / carousel

**Basic:** identify platform and stable post ID; retain URL, supplied caption/text, author handle **as reported by the source**, timestamp and the owner's reason for saving. Separate parent post, repost/quote, comments and attached media.

**Advanced:** retrieve only authorized components; preserve carousel order and comment ancestry; OCR each relevant slide; transcribe video components; distinguish original content from reactions and external linked pages. Report how many items were available and which were processed.

**Fallback:** supplied screenshots or permitted export. Never promise “all comments”: ranking, collapsed replies, moderation, deletion and API pagination change coverage.

### C. Audio / speech

**Basic:** retain an authorized original; probe duration/codec; transcribe the original language; preserve the transcript as a fallible derivative and offer a short useful summary. If no speech is detected, say so.

**Advanced:** timestamped segments, speaker labels, channel separation, language switches, searchable chapters, quotations, optional translation stored separately, and alignment back to original time ranges. Diarization labels are **Speaker 1/2**, not inferred real identities. Provide uncertainty for names, quantities, negation and dates.

**Long media:** choose a bounded relevant excerpt or a queued duration-limited job; split on sensible boundaries with small overlap, remove overlap duplicates, preserve offsets and flag gaps. Never hide processing only the first few minutes.

**Fallback:** existing publisher transcript or owner-selected excerpt. Local ASR can reduce third-party disclosure, but hardware, model downloads and transcription quality still need testing. [OPENAI-STT] [WHISPER] [FASTER-WHISPER] [WHISPERCPP] [WHISPERX]

### D. Video / Reel / demonstration

**Basic:** store the link/original and available caption; obtain authorized subtitles or transcribe authorized audio. State **audio-only analysis** if that is all that happened.

**Advanced:** combine three independent tracks:

1. **Speech:** timestamped transcription, language and speaker changes.
2. **Visible text:** captions/overlays, ingredients, measurements, product names, code, slide text and UI steps.
3. **Visual events:** selected keyframes/scenes showing actions, before/after changes, diagrams or demonstrations.

Align them by time. Do not count burned-in subtitles and their matching speech as two independent sources. Sample adaptively around scene/text changes, not every frame into an expensive model. For high-stakes details, inspect original frames around the cited moment. Mark unsampled intervals and missing visual coverage.

**Fallback:** owner-supplied allowed clip, screenshots of relevant frames, publisher transcript or an external written version. A legally obtained local file can be processed with FFmpeg/ffprobe; a site's downloadable stream URL is a separate access/rights question. [FFMPEG] [FFPROBE]

### E. Image / screenshot / scan

**Basic:** retain exact received bytes, correct orientation in a derivative, OCR/describe visible content, keep owner's note separately.

**Advanced:** regions/boxes and reading order; stitch overlapping screenshots with overlap checks; detect multi-page sequences; parse tables/receipts/UI; preserve uncertainty and page/image coordinates. Local OCR first for legible text; vision for layout/meaning or difficult cases where authorized.

**Fallback:** ask for an original file or a clearer crop in a future interaction, not a fabricated reading. Handwriting and low-resolution tiny UI text require explicit uncertainty. Store a normalized preview without replacing the original. [TESSERACT] [PDF] [EXIFTOOL]

### F. Office/PDF/table

**Basic:** original plus bounded text/table extraction using existing Pico converters; explicit unsupported/locked/OCR-required state.

**Advanced:** page/slide/sheet-aware locators, available comments/revisions, selective OCR, formula/cached-value distinction, table units and exported representations. For arithmetic, use actual parsed values and a deterministic check, not a prose model's approximate totals.

**Fallback:** readable PDF/CSV/Markdown export. A successful conversion is not proof every footnote, hidden sheet or annotation survived. [ANYDOC] [DOCLING] [MARKITDOWN] [TIKA]

### G. Structured entity / event / product / place

**Basic:** preserve supplied fields and source; extract a **candidate** record with missing fields.

**Advanced:** resolve a stable identifier, disambiguate variants/locations/timezones, compare authorized sources, and propose a normalized record with field-level evidence. “Tomorrow” on an old post refers to its publication context, not necessarily tomorrow from receipt time.

**Fallback:** keep a useful note with unknowns. Extraction is not calendar acceptance, address-book sync, purchase, booking, RSVP, reminder creation or continuous monitoring.

### H. Private cloud / account-linked source

**Basic:** save the private reference without leaking it; process an owner-selected exported copy.

**Advanced:** a separate explicitly configured read-only account connector with narrow scopes, account identity, object/revision IDs, authorization checks, refreshed short-lived download URLs and auditable receipts. Do not turn the public web fetcher into a cookie jar.

**Fallback:** download/export from the source app and send the selected file. OAuth/app review and the provider's permitted-use terms are prerequisites, not optional polish.

## 6. Social, video and audio apps

### 6.1 YouTube / YouTube Music

**Status:** documented API limits; media extraction is rights- and tool-dependent. References: [YT-CAPTIONS], [YT-DOWNLOAD], [YT-POLICY], [YT-OEMBED], [YTDLP].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Standard video, `watch` or `youtu.be` | Save ID/title/source and exact start timestamp; use permitted supplied transcript/excerpt | Recipe D: chaptered, timestamped speech plus selected visual evidence |
| Short (`/shorts/…`) | Treat as video, not as a textual post | OCR overlays and demonstrate-step extraction; short length does not make audio sufficient |
| Timestamp or clip link | Preserve requested range and original video relationship | Analyze the selected interval with nearby context; do not silently expand a clip to the full video |
| Livestream / scheduled stream | Save title, planned/live state and observation time | Analyze an authorized recording after availability; continuous live monitoring is a separate opt-in feature |
| Playlist / course | Save playlist identity and selected item's identity | Authorized bounded item inventory and progress list; no automatic download/transcription of the whole playlist |
| Channel/profile | Save channel identity and reason | Explicit feed/watch setup if later requested; not automatic subscription |
| Community post, poll, image carousel | Save supplied text/screenshots and link | Post/slide extraction where permitted; not covered by assuming a video API response contains it |
| Description / pinned comment / comments | Keep separate source components | Authorized bounded comment retrieval with timestamps and ancestry; not a complete transcript or endorsement |
| Video with no transcript, wrong-language transcript, dubbed audio | State the actual available track | Authorized ASR, alternate-track selection or separately labelled translation; do not merge different tracks |
| YouTube Music song/album/playlist | Save identity and owner note | Authorized metadata organization; do not rip music, remove DRM, or infer that Premium grants a server-side audio pipeline |

**Critical findings:** `captions.list` returns track metadata, not caption text; `captions.download` requires OAuth and permission to edit the video. YouTube's API policies prohibit unauthorized audiovisual download/storage, scraping and separation of audio/video components. A generic downloader's technical ability is not a compliant API design. Prefer creator-provided transcripts, authorized exports or licensed media; separately review any automated third-party retrieval plan. Preserve original caption language, whether the track is automatic, the chosen audio track, and temporal coverage.

### 6.2 Instagram

**Status:** documented platform restrictions; export-first for arbitrary posts. References: [IG-API], [IG-OEMBED], [IG-BASIC-END].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Single photo/feed post (`/p/…`) | URL, supplied caption and image/screenshot | OCR/description; extract recipe, place, product or quote with source attribution |
| Carousel/mixed-media post | Preserve every actually supplied item in order | Per-slide OCR plus per-video transcription; identify missing slides and combine only supplied/authorized components |
| Reel (`/reel/…`) | Link, caption, permitted supplied media or transcript | Recipe D; speech, on-screen text and demonstration timeline |
| Older video post / long video | Same as video; preserve source identity | Long-form segment processing and chapters if media is legitimately available |
| Story / story highlight | Reference, supplied screenshot/allowed export; note capture time | Ordered permitted story segments and expiry context; no promised recovery after expiry |
| Live / live replay | Link/state and provided excerpt | Authorized replay transcription and selected frame analysis; no background recording by default |
| Profile / bio / link-in-bio | Save profile and supplied bio/link | Open selected external destination with separate provenance; do not scrape followers/history |
| Comments / comment permalink | Preserve selected comment, parent context and who said what | Permissioned bounded discussion extraction; not universal access to all comments |
| Saved collection | Save shared collection reference or selected items | Explicit selected export/import; a collection link does not reveal a private saved library |
| DM / disappearing content | Owner-selected text/screenshots only, with third-party sensitivity | No account-session borrowing, covert capture or supposed generic personal-DM API |
| Audio template / effect / remix | Save label/link and relation to source Reel | Explain only available media; template/music identity is not licensed downloadable audio |

**Do not build on the wrong APIs:**

- Instagram oEmbed explicitly restricts content/metadata and derivatives to providing a front-end view. It **prohibits extraction, manipulation or persistence for other purposes**. Even if a response exposes something useful, it is not an approved memory-ingestion route.
- Instagram's documented account APIs focus on Business/Creator accounts and their scoped capabilities. They are not arbitrary-reader access to every personal account's posts, stories or DMs.
- Instagram Basic Display ended on **4 December 2024**. Tutorials that rely on it are obsolete.
- Private, age-restricted, inactive or embeds-disabled content is not made accessible by possessing a share link.

**Practical default for this use case:** keep the source link and owner's note; process supplied caption/images or a permitted video export. If an integration is later justified, verify both its scopes and its permitted AI/persistence use before choosing the endpoint.

### 6.3 Reddit

**Status:** documented endpoints/terms; approved use needs specific review. References: [REDDIT-API], [REDDIT-TERMS], [REDDIT-DEVTERMS].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Text/self post | Title/body from permitted accessible source or supplied text | Source-linked sections, edits and dates; “OP says” remains a claim |
| Link post | Preserve Reddit discussion **and** external destination as different sources | Read the linked article separately; distinguish article claims from Reddit reactions |
| Image/gallery | Supplied ordered images/captions | OCR each page/panel and preserve gallery coverage |
| Native video/GIF | Link or permitted supplied media | Probe separate audio/video components where legitimately available, then recipe D |
| Comment permalink / thread | Save exact comment plus parent context | Permissioned bounded ancestor/descendant tree with IDs, depth, sort, sample time and truncation |
| Crosspost | Keep original and crosspost communities/authors separate | Trace source chain without duplicating a copied claim as corroboration |
| Subreddit/user/wiki/megathread | Save selected page and reason | Explicit bounded retrieval; no automatic account-history or whole-community archive |
| Removed/deleted/private/quarantined/NSFW | Preserve reference and access outcome | No undelete services, age bypass or inference of missing text |

Do not design around unauthenticated `.json` URLs as an entitlement. Reddit requires documented access identity and constrains use, retention and derivations; the Data API terms do not automatically authorize a personal AI archive. Evaluate the approved use case and rights, not just OAuth availability. Comments, vote counts and awards are not reliable truth signals. If permitted processing is not established, use selected owner-supplied material subject to its rights rather than promising automatic thread ingestion.

### 6.4 TikTok

**Status:** documented embeds/Display API; export-first for full analysis. References: [TIKTOK-EMBED], [TIKTOK-DISPLAY].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Video / shortened share URL | Resolve safely, save identity/caption where legitimately supplied | Permitted media: ASR + overlay OCR + keyframes; preserve text that appears briefly |
| Photo/slideshow post | Supplied ordered screenshots/images and caption | Per-slide OCR and source sequence; accompanying music is separate from text meaning |
| Duet/stitch/reaction | Preserve visible source relationship | Separate the reacting speaker from quoted/source clip; avoid attribution reversal |
| Live / live replay | Reference and state | Authorized bounded replay/excerpt only; no automatic continuous capture |
| Profile / sound / effect / collection | Save reference and owner purpose | Selected-item organization; a sound page is not a license to download/reuse it |
| Shop/product/affiliate link | Record video claim and product destination separately | Compare independently sourced product specifications; advertising claims stay attributed |

TikTok oEmbed documents embed markup/metadata, not a general full-video transcript API. Display API is scoped around an authorized creator's profile/videos; it is not universal account or transcript access. Review current terms separately before persisting/AI-processing platform-derived metadata. A public embed should never be mistaken for all original media components.

### 6.5 Facebook

**Status:** export-first; current oEmbed feature documentation is readable, but some legacy reference paths failed. Reference: [FB-OVERVIEW].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Public post/photo/album | URL plus selected text/images | Ordered media and attributed post extraction through an approved route |
| Reel/video/live replay | Link and supplied permitted clip | Recipe D with caption/comments kept separate |
| Group/private/friends-only post | Preserve selected supplied material with privacy label | Explicit export/authorized connector if available; never borrow a personal browser session |
| Event | Extract supplied venue/date/time/organizer as candidates | Verify timezone, occurrence and cancellation; propose a calendar entry, not an RSVP |
| Marketplace listing | Save snapshot, price, location and observation time | Compare variants/condition and detect changes only under explicit monitoring policy |
| Page/profile/story | Link/screenshot and capture time | Scoped authorized public-page handling; no universal personal timeline or expired-story recovery |

oEmbed app review/display capability is not evidence of permission to scrape, summarize and retain arbitrary Facebook content. Review the exact API/product terms for the intended use rather than importing assumptions from another Meta product.

### 6.6 Threads

**Status:** documented API family; access and use remain scoped. Reference: [THREADS].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Text post/link/quote | Source identity and supplied text | Authorized post/quote separation and selected external-page capture |
| Image/video/carousel | Supplied media and caption | Ordered OCR plus permitted video processing |
| Reply chain/profile | Selected supplied reply/context | Bounded permissioned discussion; no assumed complete public-graph/history access |

The current API index documents posts, carousels, retrieval, replies, keyword search and oEmbed. That is not a grant to collect everything; check the specific endpoint's access, fields and permitted AI/persistence use.

### 6.7 X / Twitter

**Status:** public embed response shape checked; API product access must be verified. Reference: [X-API], [X-PUBLISH].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Post / long post / article | Link plus available supplied text; distinguish preview from full body | Authorized complete text retrieval with edits/source timestamp and truncation markers |
| Thread/reply/quote-post | Selected text plus parent/quoted source | Bounded ancestry and chronology; do not infer every post in a thread from one embed |
| Photo/GIF/video | Supplied media, caption and alt text if available | OCR/video pipeline with separate quoted source attribution |
| Space / recording | Link and metadata; supplied authorized transcript | Timestamped authorized recording analysis; a Space link does not prove a replay exists |
| Profile/list/community | Save target and purpose | Explicit narrow inventory/monitoring, not background scraping |
| Protected/deleted/subscriber-only | Reference and unavailable state | No access-control or paid-content bypass |

Embeds can expose display HTML and basic metadata; they are not a complete thread, article, media download or transcript. Do not hardcode a historical X pricing tier or assume free API access.

### 6.8 Bluesky

**Status:** current canonical API schemas located and reviewed after older documentation routes failed; no live endpoint integration validated. References: [BLUESKY-THREAD], [BLUESKY-POSTS], [ATPROTO-XRPC], [ATPROTO-LEXICON].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Post/reply/quote | Link and supplied text; resolve stable post AT-URI through a verified path | Documented `app.bsky.feed.getPostThread` can return a thread without authentication; cap reply depth/parent height and preserve blocked/not-found states |
| Image/video/external card | Supplied media/card context | OCR/video analysis; external article is a separate source |
| Profile/feed/list/starter pack | Save reference and explicit purpose | Selected inventory only; avoid collecting social graphs or private/moderation context |

The canonical `app.bsky` schemas now live in the `bluesky-social/bsky` repository, as the AT Protocol repository README explicitly explains. `getPosts` accepts up to 25 AT-URIs per request; a batch lookup is not a complete thread. Authenticated thread responses can add metadata/filtering, so anonymous and logged-in views need not match. Handles can change; preserve stable identity where legitimately resolved. AT Protocol is **not ActivityPub**. Open protocols do not provide blanket consent to retain sensitive deleted content; live AppView behavior, content rights and deletion handling still need implementation checks.

### 6.9 Mastodon / compatible fediverse

**Status:** documented status endpoints; instance behavior varies. References: [MASTODON], [ACTIVITYPUB].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Status / long post | Canonical origin, supplied HTML/text and content warning | Authorized status/context lookup, safe HTML, edit history where available |
| Boost / quote-like reference | Keep boosting account distinct from original author | Source-chain deduplication; copied instances are not independent corroboration |
| Image/audio/video | Alt text/caption and supplied media | OCR/transcription while preserving original alt text and sensitive-content flags |
| Thread/profile | Selected bounded source | Per-instance context retrieval with explicit gaps; remote servers can have incomplete copies |

Do not interpret follower-only/direct visibility as publicly archivable just because one instance returns a URL. Server rules, blocked federation and deletion behavior vary.

### 6.10 LinkedIn

**Status:** documented scoped Posts API; export-first for arbitrary feed content. Reference: [LINKEDIN].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Text post / newsletter / article | Selected text or readable authorized page | Separate full article from feed preview; retain author/date |
| Document carousel / slide deck | Supplied PDF/screenshots in order | Slide text/OCR and summary with slide locators |
| Video | Link plus supplied authorized media/transcript | Speech+slide/keyframe analysis |
| Job / company / profile | Snapshot of role/location/requirements or selected profile fields | Compare job criteria and explicit deadlines; no personal-profile scraping, recruiter messages or applications |

Marketing/community APIs are not a generic personal feed or people-search entitlement. A bot receiving a LinkedIn URL is not logged in as the phone user.

### 6.11 Pinterest

**Status:** export-first; developer pages tested were largely a documentation shell.

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Image pin / recipe pin | Save pin and original destination separately; supplied image OCR | Recover the original recipe/tutorial with attribution and selected visual details |
| Video/multi-page pin | Supplied ordered media | OCR/ASR and sequence-aware steps |
| Board/profile | Save reference and selected ideas | Explicit selected export/import; no silent entire-board crawl |
| Product pin | Snapshot product and seller destination | Variant/price/source comparison; the pin may be stale or an affiliate redirect |

Often the linked original site is more useful than the pin. Do not replace original authorship with Pinterest attribution alone.

### 6.12 Snapchat

**Status:** documented Public Profile API scope; export-first for personal/ephemeral content. Reference: [SNAP].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Spotlight / public saved story | Link and supplied material | Authorized selected video/story processing |
| Ephemeral story / private Snap / chat | Reference or intentionally supplied permitted excerpt | No covert capture, private-message scraping or expired-content recovery |
| Lens / profile / location | Label what was shared | Lens description rather than execution; profile/location treatment with privacy and provenance |

The Public Profile API concerns public creator/business content and partner capabilities, not universal private Snap access.

### 6.13 Vimeo / Dailymotion / PeerTube

**Status:** export-first/tool-dependent. The Vimeo API page returned a shell; an attempted help link redirected to player parameters, so it was not accepted as oEmbed evidence.

| App and type | Basic | Advanced |
| --- | --- | --- |
| Vimeo video/showcase | Link and supplied transcript/file; respect private/password access | Authorized captions/video analysis; showcase membership and download permissions checked per item |
| Dailymotion video/channel | Link and available supplied context | Permitted media/captions through a currently verified interface; recipe D |
| PeerTube video/channel/playlist | Instance URL, video identity and supplied text | Verify instance API and download/transcript permissions; process selected media; no broad federated crawl |
| Embedded player inside another site | Record wrapper page and underlying provider separately | Resolve only an authorized player/media route; no generic iframe execution |

A `yt-dlp` extractor listing is evidence that code exists, **not** a reliability, permission or DRM guarantee. [YTDLP] [YTDLP-EXTRACTORS]

### 6.14 Twitch / Kick / livestreaming

**Status:** Twitch has documented API objects; recording/transcription remains separate. Reference: [TWITCH].

| App and type | Basic | Advanced |
| --- | --- | --- |
| Twitch clip | Clip link, broadcaster/title and selected supplied media | Authorized clip speech and selected keyframes |
| Twitch VOD / highlight | Link and chosen time range | Authorized bounded transcript/chapters; distinguish unavailable/muted intervals |
| Twitch live channel | Snapshot/reference, not recording | Explicit bounded capture only with rights and operational consent; chat is separate third-party content |
| Kick stream/clip/VOD | Export-first link/excerpt | Verify current interface and rights before any automation; do not assume Twitch endpoints apply |
| Stream chat | Selected supplied text | Narrow, privacy-aware extraction if authorized; not a complete spectator archive |

### 6.15 Spotify

**Status:** strong documented policy constraint. References: [SPOTIFY-POLICY], [SPOTIFY-OEMBED].

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Podcast episode/show | Keep the owner-supplied link and note; identify an independently published source if appropriate | Process a separately authorized publisher RSS transcript/audio, **not Spotify-derived content fed into an LLM** |
| Song/album/artist | Owner's link/bookmark and independently supplied annotations | Use independently licensed metadata if needed; do not rip Spotify audio or send Spotify platform content to models |
| Playlist | Store owner-supplied reference | Any import/export must comply with the specific permitted personal-data/playlist transfer route; AI ingestion is not assumed permitted |
| Video podcast / audiobook | Bookmark/reference | Independently authorized source/export, with DRM and content rights respected |

Spotify's developer policy says not to use its platform/content to train a model **or otherwise ingest Spotify Content into a machine-learning or AI model**. This is broader than “do not train.” It also restricts analysis and certain voice-assistant use. Therefore an automatic “Spotify API → LLM summary/memory” connector is **not a default recommendation**. An oEmbed response is display data, not an audio/transcript license. Keep restricted Spotify-derived metadata out of model context, embeddings and extraction jobs unless a specific approved use is established.

### 6.16 Apple Podcasts / Pocket Casts / Overcast / AntennaPod / Podcast Addict

**Status:** documented Apple transcript UX and Podcasting 2.0 transcript links; individual app export is variable. References: [APPLE-PODCASTS], [PODCAST-RSS], [RSS].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Apple Podcasts episode/show | Link, owner's note, selected shared transcript text | Resolve an independently authorized publisher feed/transcript; retain episode GUID and source version |
| Pocket Casts episode/timestamp | Preserve episode and offset | Publisher transcript/authorized RSS enclosure; clip-specific summary |
| Overcast episode/clip | Preserve selected interval and source | Analyze a legitimately shared clip; align to episode with explicit offset |
| AntennaPod / Podcast Addict episode/feed | Episode link or selected OPML/feed export | Selected feed import and authorized transcript/audio processing; OPML import is not auto-subscription |
| Public podcast RSS | Episode metadata/show notes | Prefer `<podcast:transcript>` when present; chapters and authorized enclosure as fallback |
| Private/subscriber RSS | Treat the feed URL as a credential | Explicit scoped service, redaction and restricted retention; never send tokenized feed URLs to search |

Apple's current help describes selecting/copying **up to 200 words** of transcript for sharing; the presence of a transcript in the app is not evidence of a public bulk-transcript endpoint. Dynamic advertising and edits can shift timestamps across listening apps and downloads. Preserve the exact edition/audio version analyzed.

### 6.17 SoundCloud / Bandcamp / Mixcloud / Audiomack

**Status:** SoundCloud oEmbed is documented; full-content AI processing is export/license-dependent. References: [SOUNDCLOUD], [BANDCAMP].

| App/type | Basic | Advanced |
| --- | --- | --- |
| SoundCloud track/set | Link plus supplied note/description | Creator-permitted download or supplied speech recording → ASR; comments/time markers remain separate |
| Bandcamp album/track | Bookmark and independently supplied metadata | Process an owner's lawfully obtained, permitted local file; purchases/download permissions are not automatic model-ingestion rights |
| Mixcloud show/DJ mix | Reference, set list if legitimately supplied | Authorized spoken-segment extraction; no stream ripping |
| Audiomack track/podcast | Reference and supplied excerpt | Current permissioned export/interface verification before automation |

For music-first content, identifying an album to remember is usually enough. Do not spend transcription on instrumental audio or promise lyric reproduction.

## 7. Messaging, email and meetings

### 7.1 Telegram itself

**Status:** documented API, current Pico subset inspected. References: [TG-API], [TG-FAQ], [channels](CHANNELS.md).

| Shared type | Basic | Advanced |
| --- | --- | --- |
| Owner text/voice/caption | Preserve explicit owner request separately from evidence | Transcription and action extraction subject to current tool authority; consequential ambiguity stays visible |
| Forwarded person/bot/channel post | Preserve supplied origin and body as external evidence | Source-linked summary and selected media processing; origin is not authorization |
| Telegram public/private message link | Save reference; use actually forwarded/supplied content | A future separately authorized integration could resolve allowed objects; a bot cannot read arbitrary chat history from a link |
| Photo/document/audio/video/video note | Current retained-original path | Add recipes C–F without widening sender/retention boundaries |
| Album/media burst | Current ordered intake | Coverage manifest, page order and per-item outcomes |
| Contact/location/venue/poll/dice | Current labelled evidence | Optional structured extraction, not native action or inferred identity |
| Story/paid media/protected content | Explicit unavailable/reference-only state | No purchase, unlocking, content-protection bypass or secret-chat support |
| Edited/deleted/live-location update | Record only actually received update semantics | Version/tombstone support needs explicit implementation; no claim of a complete historical sync |

Do not confuse Telegram **Saved Messages** with messages sent to Pico: the bot does not gain access to the owner's Saved Messages or other chats merely because the same person owns them. Protected-forwarding restrictions must be respected.

### 7.2 WhatsApp

**Status:** export-first. The help URL tested exposed only a title, so current device-specific export steps were not verified.

| Type | Basic | Advanced |
| --- | --- | --- |
| Shared message/selected text | Send chosen text or screenshots to Pico; preserve sender/time if supplied | Identify decisions, dates and tasks as attributed candidates |
| Voice note/photo/video/document | Selected permitted file forwarded/shared out to Telegram | Common media/document pipeline; no account access required |
| Chat export with/without media | Bounded chosen export and manifest | Parse chronology, message/media associations and timezone; avoid importing unrelated participants/history |
| Status/channel/community/invite link | Reference and deliberately supplied excerpt | No joining, scraping or monitoring automatically |

WhatsApp Business APIs are not a read API for an individual's personal WhatsApp history. Do not recommend unsupported session-cloning libraries as a default personal assistant integration.

### 7.3 Signal

**Status:** export-first; official backup/transfer documentation reviewed. Reference: [SIGNAL].

| Type | Basic | Advanced |
| --- | --- | --- |
| Selected text/media | Explicit selected share/copy where the device permits | Common extraction with third-party privacy labels |
| Disappearing/view-once content | Respect intended privacy and capture restrictions | No covert recording or disappearance bypass |
| Backup/transfer artifact | Treat as sensitive opaque data | No claim that a transfer or encrypted backup is a generic plaintext export; supported owner-controlled migration is separate from Pico ingestion |

Signal does not provide this research with a verified generic personal-message ingestion API. Copying selected evidence is much narrower than granting a daemon access to a secure messenger database.

### 7.4 iMessage / Apple Messages / SMS / RCS / Google Messages

**Status:** export-first proposals; no mobile message-database connector validated.

| App/type | Basic | Advanced |
| --- | --- | --- |
| iMessage selected conversation/photo/voice | Selected text/screenshots/files via explicit share | Multi-screenshot chronology and attached-file association |
| SMS/RCS appointment, tracking, receipt | Selected text and URLs | Candidate event/tracking reference with sender and receipt time; don't treat sender ID as verified |
| OTP, account recovery, login QR | Warn against retention/model ingestion | Dedicated secret handling if ever needed; not searchable memory |
| “Share location” / payment / app extension card | Preserve only supplied inert data | No sending money, opening login actions or ongoing location tracking |

An optional phone Shortcut can later package **user-selected** text/file plus source app label. Do not equate that with permission to read all notifications or the entire message database.

### 7.5 Messenger / Instagram DMs / LINE / KakaoTalk / WeChat / Viber

**Status:** export-first. LINE documents account-specific webhook delivery, not universal personal-chat access. Reference: [LINE].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Messenger / Instagram DM excerpt | Selected text/screenshots/media | Attribution-aware summary; business messaging scopes do not imply personal-inbox access |
| LINE message/album/file | Explicit chosen share/export | Parse supported export and preserve attachment gaps; Official Account webhooks are a different product |
| KakaoTalk chat/file | Selected export/screenshots | Bounded chronology and source linkage after actual export format is verified |
| WeChat article/chat/mini-program card | Readable article or selected supplied text/images | Article extraction if legitimate; mini-program payload is not an executable task or readable page |
| Viber conversation/voice | Selected copied text/media | Common pipelines; backup formats require separate verification |

For all of them, a message's command-like wording belongs to its sender, not automatically to the Pico owner.

### 7.6 Discord

**Status:** documented message objects and bot permissions/intents; not personal-history entitlement. Reference: [DISCORD].

| Type | Basic | Advanced |
| --- | --- | --- |
| Message/thread permalink | Supplied selected text or export | Permissioned bot access to the specified channel/thread, with current intents/scopes and bounded pagination |
| Attachment/embed | Retain actually supplied file; separate embed preview from source | Refresh authorized attachment references when appropriate; do not depend indefinitely on a signed CDN URL |
| Voice message/recording | Permitted supplied media | ASR and speaker labels; never join/record voice channels automatically |
| Forum post/server invite | Save reference/context | No auto-join or whole-server ingestion |

### 7.7 Slack

**Status:** documented authenticated conversation replies. Reference: [SLACK].

| Type | Basic | Advanced |
| --- | --- | --- |
| Message/permalink/thread | Owner-selected text or export | Explicit workspace read scopes, bounded thread retrieval, author/time and incomplete history markers |
| File/canvas/snippet | Supplied export/file | Authenticated file retrieval and document conversion; the permalink is not the bytes |
| Huddle/clip/meeting summary | Supplied permitted transcript/recording | Timestamped extraction with participants/consent context |
| Workspace/channel export | Selected scope only | Admin/organization-approved import; not implicit permission from one employee sharing a link |

### 7.8 Microsoft Teams

**Status:** documented Microsoft Graph chat-message access; work-tenant approval can be required. Reference: [TEAMS].

| Type | Basic | Advanced |
| --- | --- | --- |
| Chat/channel message | Selected supplied text/screenshots | Authorized Graph retrieval with tenant/account identity and hosted content |
| Meeting recording/transcript | Supplied allowed transcript/file | Permissioned recording/transcript retrieval, speaker/time alignment and meeting occurrence identity |
| SharePoint attachment / Loop component | Readable export | Separate file/component permission checks; a Teams message does not guarantee permission to every linked resource |

### 7.9 Gmail / Outlook / Apple Mail / Proton Mail / Fastmail

**Status:** Gmail/Graph-style account access is documented; this catalog does not configure it. References: [GMAIL-GET], [MS-DRIVE], [EMAIL], [GOOGLE-TAKEOUT].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Gmail message/thread link | Preserve private reference; selected text/EML/PDF | Pico's explicitly configured Gmail service may read authorized messages; separate sender, forwarded bodies and attachment evidence |
| Outlook email / Microsoft 365 item | Selected EML/MSG/PDF or text | Scoped Microsoft Graph mail integration if implemented; tenant/organizational policy first |
| Apple Mail message | Selected text/EML/PDF/attachments | MIME-aware threading and attachment extraction; `message:` deep links are not public URLs |
| Proton Mail / Fastmail message | Owner-selected export/file | Supported scoped export/bridge/IMAP path only if explicitly implemented and authorized; no claim of current encrypted-mail integration |
| Attached email / nested thread | Read envelope and selected body; show quoted levels | Distinguish new message from forwarded history and quoted signatures/disclaimers |
| Newsletter / promotion / invoice | Extract content with source date | Unsubscribe and payment links stay inert; no remote tracking-image loads |
| Calendar invitation | Parse event candidate | No accept/decline/send/update without separate owner action and integration authority |
| MBOX / account export | Bounded manifest; select useful subset | Deduplication, date/attachment lineage and erasure; avoid importing an entire mailbox by accident |

An email “view in browser” URL can contain a subscriber-specific token. Do not submit it to public search or treat it as a public article.

### 7.10 Zoom / Google Meet / Webex

**Status:** export-first; Zoom's API documentation returned a shell in this research.

| App/type | Basic | Advanced |
| --- | --- | --- |
| Zoom cloud/local recording or transcript | Supplied permitted recording, VTT or text | Explicit recording scopes and account permissions, speaker/time alignment; password/capability links stay private |
| Google Meet recording/transcript | Selected authorized Drive/Docs export | Use configured appropriate Google read services; distinguish meeting record from generated AI notes |
| Webex recording/transcript | Supplied authorized export | Verify supported recording/transcript interface before automation |
| Meeting invite/join URL | Read time/agenda if supplied | Candidate calendar entry; never auto-join, record, accept or invite people |

Meeting transcripts contain third-party confidential speech. Participant consent, employer rules and applicable law matter even when the owner can download the recording.

## 8. Browsers, news, newsletters and read-later apps

### 8.1 Safari / Chrome / Firefox / Edge / Brave

**Status:** documented sharing/print patterns; export-first for authenticated pages. References: [ANDROID-SHARE], [APPLE-SHARE-EXT], [CHROME-PDF].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Safari webpage/selected text | URL + owner note, selected text or PDF | Recipe A; preserve reader-mode vs original-page provenance |
| Chrome webpage/print PDF | URL or exported PDF | Parse HTML/PDF with source URL and page date; no reading phone cookies |
| Firefox/Edge/Brave page | URL/selected text/screenshot | Same shared pipeline, not one connector per browser |
| Reading-list/bookmark export | Selected links or HTML export | Bounded import with tags/folders and duplicate resolution |
| Open tabs / tab group | Explicit selected URL bundle | Ordered topic grouping; no automatic browser-history import |
| Full-page screenshot / offline page | Supplied file | Stitching/OCR or local asset bundle; do not claim missing interactive content |

### 8.2 News sites and publishers

Examples include BBC, Reuters, AP, The Guardian, New York Times, Washington Post, Financial Times, The Economist, Bloomberg, Wired, The Verge, Ars Technica, ANSA, Rai News, Il Post, Corriere and la Repubblica. These are **separate publishers with separate terms**, not one guaranteed-access integration.

| Type | Basic | Advanced |
| --- | --- | --- |
| Public article | Read permitted accessible body; author/date/source | Section/table extraction, version and correction tracking, supporting original reports |
| Live blog | Selected update with event time | Bounded update range, chronology, revisions and “as of” summary; not perpetual polling |
| Opinion/editorial | Preserve genre and attribution | Distinguish argument from reported facts and cited evidence |
| Infographic/photo essay | Supplied images/captions or permitted source | OCR/visual reading with image order and credit |
| Subscriber/paywalled article | Keep link and supplied permitted excerpt | Owner-selected allowed export; no paywall bypass, credential borrowing or arbitrary mirror service |
| News audio/video | Link + provided transcript/excerpt | Authorized media pipeline and written-source comparison |

A mobile “share” preview often has only a headline and teaser. Pico must not summarize the full article from that alone.

### 8.3 Substack

| Type | Basic | Advanced |
| --- | --- | --- |
| Public newsletter post | Permitted public page or supplied email/text | Article structure, citations and author/publication date |
| Paid/private post | Link plus owner-supplied allowed excerpt/export | No subscriber-cookie borrowing or paywall bypass |
| Note / reply / restack | Selected text and quoted source | Keep original and commentary separate |
| Podcast/video post | Supplied transcript or authorized publisher source | Audio/video pipeline; subscriber RSS URL treated as secret |

### 8.4 Medium / WordPress / Ghost / personal blogs

| App/type | Basic | Advanced |
| --- | --- | --- |
| Medium article | Permitted readable text or supplied export | Article extraction; do not assume alternate domains bypass membership legitimately |
| WordPress article/page | Public readable page or selected feed content | Structured sections/media with revision/publication date |
| Ghost post/newsletter | Public page or supplied email/export | Member content only through authorized route |
| Personal blog / RSS item | Recipe A / selected RSS entry | Full-text vs summary distinction; follow permitted original rather than treat feed teaser as complete |

### 8.5 Reddit-style news/discussion: Hacker News / Lobsters / Discourse / Lemmy / Kbin-like communities

| App/type | Basic | Advanced |
| --- | --- | --- |
| Hacker News story/comment | Link and supplied text, linked article separately | Verify current public interface; bounded ancestry and comment source attribution |
| Lobsters story/thread | Same separation | Bounded permitted discussion; scores not truth |
| Discourse topic/post | Readable selected page or export | Verify instance API/permissions, pagination and edits; private forums stay private |
| Lemmy / compatible federated community post | Origin URL and selected content | Instance-aware bounded retrieval; federation copies are not independent evidence |
| Traditional forum / phpBB / specialist board | Selected page/text | Multi-page thread only within explicit bounds and site permissions |

### 8.6 Readwise Reader / Readwise

**Status:** documented Reader API; explicit account setup required. Reference: [READWISE].

| Type | Basic | Advanced |
| --- | --- | --- |
| Saved article/PDF/video | Supplied source/export | Scoped selected-document retrieval; retain original source vs Reader representation |
| Highlight/note | Exact quote, owner's annotation and original locator | Source-linked personal insights; a highlight is interest, not agreement |
| Exported library | Manifest and selected subset | Import tags/reading states without silently processing everything |

### 8.7 Instapaper / Raindrop.io / Wallabag / Omnivore-derived exports

**Status:** Raindrop API docs readable; other current deployments/APIs not verified. Reference: [RAINDROP].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Instapaper saved article/highlight | Selected text/export | Verify current API availability; preserve quote and note separately |
| Raindrop bookmark/collection | URL, note/tags or export | Scoped selected bookmark import and source fetch; collection membership is not permission to read private destinations |
| Wallabag article/export | Selected article text/export | Explicit self-hosted account connector if useful; source and local annotations separated |
| Omnivore or migrated archive | Supplied export only | Verify service/deployment status and schema; do not promise an old hosted API remains usable |
| Old Pocket export/link | Import a supplied historical bookmark export where available | Check current service lifecycle before proposing OAuth/live sync; this research could not verify the shutdown help page behind its challenge |

### 8.8 Feedly / Inoreader / NetNewsWire / Reeder / RSS readers

| Type | Basic | Advanced |
| --- | --- | --- |
| Shared item | Original URL, title, selected text | Full permitted article fetch and source attribution |
| RSS/Atom/OPML export | Bounded feed/link inventory | Explicit selected feed import and authorized scheduling; subscription list may expose private interests/tokenized feeds |
| Highlight/tag/starred collection | Selected export | Keep reader annotations distinct from publisher text; no silent continuous monitoring |

## 9. Cloud storage, office, notes and design

### 9.1 Google Drive

**Status:** documented download/export distinction. References: [GOOGLE-DRIVE], [GDRIVE-EXPORT], [GOOGLE-TAKEOUT], [Google in Pico](GOOGLE.md).

| Type | Basic | Advanced |
| --- | --- | --- |
| PDF/image/audio/video/blob | Selected download uploaded to Telegram | Scoped authorized original download, then common pipeline |
| Google-native document | Owner-selected PDF/DOCX/CSV/etc. export | Correct native export interface; capture object/revision and representation type |
| Folder/shared drive/shortcut | Save reference or selected manifest | Explicit bounded traversal; resolve shortcut target with independent permission check |
| “Anyone with link” file | Treat as private/capability access unless established otherwise | No public-search leakage; connector with minimum scopes |
| Large file / Google Vids | Reference and selected permitted export | Verify product-specific download flow, limits and media support; not assumed to work through existing public web fetch |

A Drive HTML preview is not the original document. Download restrictions and `canDownload`/permissions matter; export formats have product-specific limitations.

### 9.2 Google Docs / Sheets / Slides / Forms

**Status:** Docs/Sheets/export interfaces documented. References: [GOOGLE-DOCS], [GOOGLE-SHEETS], [GDRIVE-EXPORT].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Docs document | DOCX/PDF/text export | Scoped structured read, headings/tables/notes and revision identity; comments/suggestions are separate coverage questions |
| Sheets workbook/range | Selected CSV/XLSX export | Preserve sheet/range, locale, formulas vs displayed/cached values, hidden data and row lineage |
| Slides deck | PDF/PPTX export | Slide text + speaker notes + rendered-slide diagrams/OCR with slide locators |
| Forms questionnaire/results | Selected supplied questions/exported answers | Explicit authorized response retrieval if implemented; opening a form is not submitting it |
| Published-to-web object | Read permitted published view | Distinguish published snapshot from live private original |

### 9.3 OneDrive / SharePoint / Microsoft 365

**Status:** documented Microsoft Graph file-content download. Reference: [MS-DRIVE].

| App/type | Basic | Advanced |
| --- | --- | --- |
| OneDrive/SharePoint file link | Selected exported file | Scoped Graph read, authenticated object identity and current version; safe handling of redirect/download URLs |
| Word / Excel / PowerPoint | Supplied DOCX/XLSX/PPTX/PDF/CSV | Common office pipeline with comments/formulas/slide limitations |
| OneNote page/notebook | Selected PDF/text/export | Verify supported tenant API; preserve page sections, handwriting and attached files; no whole-notebook crawl |
| Loop component | Supplied readable export/screenshot | Specialized authorized structure reader only after interface verification |
| Folder/team site | Reference/manifest | Explicit selected scope; organizational permission is not inferred from employee access |

### 9.4 Dropbox / Box / Nextcloud / iCloud Drive / Proton Drive / pCloud

**Status:** export-first; Nextcloud documents WebDAV. Dropbox's reference page returned a shell. Reference: [NEXTCLOUD].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Dropbox file/folder/Paper | Selected file/export; preserve shared reference | Explicit scoped download and Paper export if currently supported; no blanket folder sync |
| Box file/note | Selected original/PDF/text | Verify enterprise-approved API scopes, versions and download policy |
| Nextcloud file/share | Selected supplied file | Explicit read-only WebDAV/account or authorized share access; no broad host mounts |
| iCloud Drive file/folder | Download/share a copy from Files | No assumed general server-side iCloud Drive API or phone Apple-ID session access |
| Proton Drive file | Selected downloaded copy | Encryption/account-specific integration requires separate supported design; no ambient bridge discovery |
| pCloud/MEGA/other encrypted cloud | Selected copy | Verify supported decryption/access model separately; a link may contain a decryption capability |

### 9.5 Notion

**Status:** documented block recursion and file expiry. References: [NOTION], [NOTION-CHILDREN], [NOTION-FILES].

| Type | Basic | Advanced |
| --- | --- | --- |
| Public/shared page | Supplied Markdown/HTML/PDF export or permitted readable page | Explicit Notion integration with shared access; recursively paginate blocks/children |
| Database/data source/view | Selected CSV/Markdown export | Properties, selected records, relations and filters; the visible view may be only a subset |
| Nested page/toggle/callout | Preserve supplied hierarchy | Recursive coverage manifest, bounded depth; a page/block header is not its full content |
| Attached file/image | Selected copy | Refresh authenticated file URL before retrieval; Notion-hosted file URLs are documented as valid for one hour |
| Comment/AI summary | Keep as separate attributed component | Do not treat generated summary as original evidence or assume comments are in block text |

### 9.6 Obsidian / Logseq / Joplin

**Status:** file/export-first; Joplin Data API documented. Reference: [JOPLIN].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Obsidian note/selected text | Markdown plus selected attachments | Resolve supplied local wiki links, frontmatter and block IDs; `obsidian://` links are inert |
| Obsidian vault ZIP | Bounded manifest, selected notes | Relative-asset import and deduplication; never import `.obsidian` plugins/settings as executable configuration |
| Logseq page/graph export | Selected Markdown/Org text | Preserve block hierarchy and references; no graph-wide import by default |
| Joplin note/export | Selected Markdown/JEX/exported resources | Explicit supported API access if useful; token stays private and service reachability is deliberately configured |

### 9.7 Apple Notes / Google Keep / Samsung Notes / Evernote / Bear / Standard Notes

**Status:** export-first proposals; current app-specific APIs/export fidelity not validated.

| App/type | Basic | Advanced |
| --- | --- | --- |
| Apple Notes note/scan/checklist | Share selected text, PDF, scan or images | OCR/checkbox structure and supplied attachments; shared-note link is not a general Notes API |
| Google Keep note/list/drawing | Supplied text/images or selected Takeout export | Preserve labels/check state/dates; no assumption of universal consumer Keep API |
| Samsung Notes handwritten/annotated note | PDF/image/text export | Handwriting/OCR, page order, annotation uncertainty |
| Evernote note/notebook | Selected HTML/ENEX/PDF | Resource association, tags, source URLs and export-version checks; old API tutorials need revalidation |
| Bear note | Selected Markdown/text/export | Tags and referenced assets; not automatic access via app URL scheme |
| Standard Notes encrypted note | Explicit decrypted selected export | No promise to read encrypted sync data; plugins and credentials remain separate |

### 9.8 Figma / FigJam / Canva / Miro / Whimsical / Excalidraw / draw.io

**Status:** Figma/Canva file/design interfaces documented; other readers export-first. References: [FIGMA], [CANVA].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Figma design/frame | Supplied PDF/PNG/SVG and source link | Explicit scoped file/frame retrieval; text/layer tree plus rendered visual and node identity |
| FigJam board | Selected board export/screenshots | Preserve arrows, clusters, sticky-note authorship where supplied; coordinate layout has meaning |
| Canva design/deck | PDF/PNG/PPTX export | Scoped authorized design export where supported; metadata response alone is not full design content |
| Miro board | Selected PDF/image/CSV | Verify account API, selected-frame scope and relationships |
| Whimsical diagram | Image/PDF/selected text | OCR nodes/edges with confidence; no execution of embedded links |
| Excalidraw drawing | PNG/SVG or selected JSON | Parse text/shapes/edges as inert data; scene geometry plus rendering |
| draw.io/diagrams.net | PNG/PDF/XML export | Safe XML parse and diagram graph with labels; no remote resource fetching by default |

### 9.9 Task/project apps: Todoist / TickTick / Things / Apple Reminders / Trello / Asana / Jira / Linear

**Status:** export-first unless a connector is separately built; Jira/Trello object APIs documented. References: [JIRA], [TRELLO].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Todoist / TickTick task or project | Selected text/CSV/export | Verify scoped read API; preserve task IDs, due vs deadline, recurrence and completion state |
| Things task/project | Selected text/export | App-only URL is not readable content; no executing task-creation links |
| Apple Reminders list/item | Selected text/screenshot | Parse check states/dates as candidates; no assumed generic daemon Reminders access |
| Trello card/board | Supplied card/export | Explicit API scope, card checklist/comments/attachments and board limits |
| Asana task/project | Selected task/export | Scoped verified read API and selected subtask scope |
| Jira issue | Supplied text/export | Authorized issue/comments/history with attachment permissions; tenant identity fixed |
| Linear issue/project | Supplied excerpt/export | Explicit scoped current API integration if justified |

Importing a task reference is not authorization to duplicate, complete, reschedule or sync the original task.

## 10. Research, development and learning

### 10.1 GitHub

**Status:** documented content/issues/gists APIs. References: [GITHUB], [GITHUB-ISSUES], [GITHUB-GISTS].

| Type | Basic | Advanced |
| --- | --- | --- |
| Repository/README | Link, license and selected readable docs | Bounded documentation inventory at a pinned commit; no clone/install/execute by default |
| File/line permalink | Exact commit/path/line range | Read surrounding context and linked definitions within bounds; branch URLs can change |
| Issue/discussion | Selected body/comments | Authorized bounded thread and timeline; issues, discussions and PR reviews are different endpoints |
| Pull request/diff | Supplied diff and context | Pinned base/head, review threads and tests reported separately; never merge/run attached code automatically |
| Gist | Inert selected text | Multi-file manifest and revision pinning |
| Release/asset | Release notes/reference | Bounded signed/checksummed metadata inspection if needed; no installing binaries |
| GitHub Pages | Public article pipeline | Source attribution distinct from repository metadata |

### 10.2 GitLab / Bitbucket / Codeberg / SourceHut

**Status:** GitLab file API documented; others export-first pending interface verification. Reference: [GITLAB].

| App/type | Basic | Advanced |
| --- | --- | --- |
| GitLab repo/file/issue/MR | Selected text/export and source | Explicit scoped current API, pinned revision and bounded discussion |
| Bitbucket repo/PR | Link plus supplied content | Verify repository permission and current API; preserve commit identity |
| Codeberg/Forgejo repo/issue | Public selected source | Verify instance API and scopes; no treating all Forgejo instances as one trust domain |
| SourceHut patch/list discussion | Inert patch/email/source | Preserve patch series and message IDs; no applying patches or running tests implicitly |

### 10.3 Stack Overflow / Stack Exchange / technical Q&A

**Status:** documented Stack Exchange question API. Reference: [STACK].

| Type | Basic | Advanced |
| --- | --- | --- |
| Question | Title/body/tags and link | Selected answers/comments with attribution and source license |
| Specific answer | Preserve exact answer plus question/context | Distinguish accepted/upvoted from currently correct; verify version-sensitive claims |
| Code snippet | Read as inert evidence | Explain safely; never execute copied code automatically |
| Chat/Teams/private Q&A | Selected permitted export | Separate current private-product access check; public API is not blanket private access |

### 10.4 arXiv / DOI / Crossref / PubMed / PMC / journal sites

**Status:** documented metadata/APIs; full-text licensing varies. References: [ARXIV], [CROSSREF], [PMC].

| App/type | Basic | Advanced |
| --- | --- | --- |
| arXiv abstract/PDF | Metadata, version ID and accessible permitted full text | Section/figure/table reading, citations and equations; distinguish preprint version from publication |
| DOI link / Crossref record | Resolve identifier and bibliographic metadata | Permitted full-text source, corrections/retractions and publication/version relationships |
| PubMed record | Bibliographic/abstract information | Full text only where legitimately available; abstract is not the entire paper |
| PMC article | Available permitted full text and license | Structured XML, tables, references and asset reading; respect per-article license |
| Publisher journal article | Accessible abstract or supplied allowed PDF | Source-specific full text and supplementary materials; no paywall/campus-login bypass |
| Supplement/dataset/protocol | Separate original and manifest | Specialized bounded reader, units and link to parent paper; not assumed to be covered by paper text |

Do not turn a saved study into a personal health recommendation or universal fact. Record study population, date, limitations and whether the saved item is an abstract, full paper or commentary.

### 10.5 Zotero / Mendeley / Paperpile / Semantic Scholar / ResearchGate / Google Scholar

**Status:** Zotero API documented; other products export-first here. Reference: [ZOTERO].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Zotero item/collection/annotation | Selected bibliographic export and permitted attachment | Explicit library API, selected collection, annotation page/quote and attachment permissions |
| Mendeley / Paperpile item | RIS/BibTeX/PDF export | Verify current account API; deduplicate DOI/version, not just title |
| Semantic Scholar paper | Public metadata/link and supplied paper | Verify current API and licenses; generated summaries are secondary evidence |
| ResearchGate publication | Bibliography and supplied allowed file | No assumption that an uploaded full text is freely reusable or account access is available |
| Google Scholar result/profile | Selected citation/reference | Prefer DOI/publisher/source metadata; no search scraping or CAPTCHA bypass |

### 10.6 Wikipedia / Wikidata / Wikisource / Internet Archive / Open Library

**Status:** MediaWiki and Open Library interfaces documented. References: [WIKIPEDIA], [OPENLIBRARY], [IIIF].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Wikipedia article/section | Readable text with language and revision | Footnotes, original citations and revision-specific quotation |
| Wikidata entity | Selected structured claims with qualifiers | Reference-aware claims and historical validity; labels alone are not a complete entity |
| Wikisource text | Available text plus edition/page | Page scans and OCR alignment where licensed |
| Internet Archive item | Metadata and selected legally available file | Verify access/borrowing restrictions and edition; no bypass of lending/DRM |
| Open Library work/edition | Metadata and reading-list note | ISBN/edition resolution; work identity is not a license to full book content |

### 10.7 Online courses and language/learning apps

| App/type | Basic | Advanced |
| --- | --- | --- |
| Coursera / edX course/lecture | Course link and permitted supplied notes/transcript | Authorized selected transcript/slides with timestamps; no paid-course scraping |
| Udemy / Skillshare lesson | Bookmark and user-selected permitted excerpt | Process provided lesson material only when allowed; no course-wide download |
| Khan Academy lesson/video | Link and accessible permitted written material | Combine authorized lesson transcript, diagrams and source-linked study note |
| Duolingo / Babbel / Busuu screenshot | OCR exercise and owner's question | Explain language with uncertainty; do not infer full learning history from one screenshot |
| Anki / Quizlet deck/card | Selected text/export | Safe card parsing and source-linked candidates; Anki packages can contain media/HTML and must not execute scripts |
| Moodle / Canvas / Blackboard assignment | Selected permitted PDF/text | Extract explicit deadline/timezone and requirements; no login borrowing, submission or plagiarism workflow |

### 10.8 AI chat, research and generated-artifact apps

**Status:** ChatGPT and Claude sharing semantics documented; other services export-first pending current verification. References: [OPENAI-SHARED-CHAT], [CLAUDE-SHARED-CHAT].

| App/type | Basic | Advanced |
| --- | --- | --- |
| ChatGPT shared conversation/individual response | Preserve shared URL and actually supplied/read conversation, with user/assistant roles | Snapshot/version-aware extraction and selected cited-source verification; personal vs workspace access differs |
| Claude shared chat | Supplied/read snapshot and artifacts, roles preserved | Verify original cited sources; attached files and raw MCP tool data are not included in the documented shared snapshot |
| ChatGPT / Claude account export | Selected conversation/manifest, not the entire account by default | Branch/message chronology, model-generated artifacts and attachment associations; export formats and missing files explicitly tracked |
| Perplexity / Gemini / Copilot / Grok / DeepSeek / other shared answer | Owner-supplied text/PDF/screenshots or permitted readable share page | Verify current sharing/access semantics and independently retrieve selected original citations; search-like presentation is not proof sources were read |
| NotebookLM notebook/audio overview/report | Selected authorized source/export or generated output | Keep notebook source documents distinct from generated summary/podcast; do not assume shared notebook grants every source file |
| Claude artifact / ChatGPT generated file / AI app code | Inert text, image, PDF or bounded file manifest | Static explanation and source links; never execute generated HTML/apps/scripts or install their dependencies |
| Shared scheduled task / agent workflow | Read as external proposed instructions and supplied schedule | No automatic installation, scheduling, connector access or inherited owner authority |

An AI answer is **secondary generated evidence**, not independent corroboration of its citations. Preserve the original owner annotation separately from user prompts inside an imported conversation. A shared chat can omit branches, later messages, uploaded files, raw tool results or workspace-restricted material; coverage is product-specific. The reviewed ChatGPT help says supported files/images can appear depending on sharing experience and permissions; the reviewed Claude help says attached files themselves and raw MCP data remain private. Do not generalize one app's behavior to the other.

## 11. Maps, travel, events and local places

### 11.1 Google Maps

**Status:** documented Maps URL parameters; URLs are not a Places data license. Reference: [GOOGLE-MAPS].

| Type | Basic | Advanced |
| --- | --- | --- |
| Place/business pin | URL, supplied name/address and owner note | Explicit appropriately licensed place lookup, stable place ID, opening-hours observation time |
| Coordinates/dropped pin | Preserve exact coordinates, supplied label and time | Reverse geocode with configured provider and privacy policy; avoid home inference |
| Directions/route | Preserve origin/destination/waypoints/mode if supplied | Route proposal and time estimates from explicitly enabled service; not navigation tracking |
| Saved list | Reference/selected places | Explicit selected export/import; list link may be private or partial |
| Review/photo/menu | Supplied selected evidence | Keep reviewer/date and owner note; third-party review/photo reuse has licensing constraints |
| Live location | Capture received point/time only | Separate explicit time-limited tracking design; not indefinite retention by default |

Short map links need safe redirect resolution. Query text, coordinates and place identity are different fields; keep the actual resolved place rather than rely only on a human-readable slug.

### 11.2 Apple Maps / OpenStreetMap / Organic Maps / MAPS.ME / Waze

**Status:** OSM data documentation reviewed; Apple Maps current developer page exposed a shell. Reference: [OSM].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Apple Maps place/guide/route | Supplied link/name/pin | Verify current unified Maps URL semantics; selected guide places, no general private-guide access |
| OpenStreetMap object/map link | Coordinates/object identity and source | Licensed selected OSM data, attribution and version; not an entire region download for one pin |
| Organic Maps / MAPS.ME bookmark/route | Supplied KML/KMZ/GPX or link | Bounded route/place import with local asset protections |
| Waze destination/route | Preserve destination and supplied context | Current route interface only if justified; no persistent location tracking |

### 11.3 Tripadvisor / Yelp / Foursquare / TheFork / OpenTable

| App/type | Basic | Advanced |
| --- | --- | --- |
| Tripadvisor attraction/hotel/review | Bookmark plus selected text/image | Place disambiguation and independent comparison; review licensing/access checked |
| Yelp business/review/menu | Name/place/source date | Appropriately licensed API or supplied menu; no review scraping assumption |
| Foursquare place/list | Selected place/reference | Current licensed lookup if implemented; no historical check-in import by default |
| TheFork / OpenTable restaurant | Location, menu/booking reference and owner note | Extract supplied reservation date/time/party size; no booking, deposit or cancellation |

Prices, hours, menus and ratings are time-sensitive snapshots. “Remember this restaurant” should usually create a place-to-try entry, not a reservation or a claim that the owner liked it.

### 11.4 Booking.com / Airbnb / Expedia / Hotels.com / Hostelworld

| App/type | Basic | Advanced |
| --- | --- | --- |
| Booking.com property | URL, dates/guests if supplied, observed price/currency | Compare like-for-like room, cancellation, taxes and total; availability changes |
| Airbnb listing/collection | Listing and supplied details/screenshots | Rules, amenities and selected date-specific quote; no login/scraping or hidden host contact discovery |
| Expedia / Hotels.com itinerary | Selected receipt/PDF/text | Parse hotel/flight components with confirmation secrets private |
| Hostelworld listing/booking | Selected listing/confirmation | Room/bed type, cancellation and local times; no automatic purchase/cancel |

A listing URL alone does not establish dates, party size, final price or an actual booking. Keep browsed options separate from confirmed reservations.

### 11.5 Airlines / trains / buses / ride-sharing

| App/type | Basic | Advanced |
| --- | --- | --- |
| Airline app / boarding pass / wallet pass | Selected PDF/image/PKPASS, flight/date/local airport times | Extract itinerary and check-in window; hide barcode/PNR; verify changes only through an explicitly configured authorized source |
| Trainline / Trenitalia / Italo / SNCF / DB / national rail | Ticket/route link or supplied file | Segment/seat/platform if actually supplied, local date/time and refund conditions; no ticket activation |
| FlixBus / coach ticket | Selected ticket details | Stops/timezones and luggage/rules; no booking or cancellation |
| Uber / Lyft / Bolt / Free Now ride | Selected itinerary/receipt | Expense and pickup/drop-off note with precise location minimization; no requesting a ride |
| Transit / Citymapper / Moovit route | Route link/screenshot | Parse directions and explicit time context; live transit requires a licensed current feed |
| GTFS dataset | Metadata/selected route | Specialized bounded schedule reader; realtime is a separate data source, not the static timetable |

Reference: [GTFS]. Boarding passes and confirmation links are access credentials in practice; do not publish them in summaries or include them in general model context unless strictly necessary.

### 11.6 Eventbrite / Ticketmaster / Meetup / Facebook Events / DICE / Resident Advisor / Bandsintown

**Status:** Eventbrite/Ticketmaster interfaces documented; other services export-first. References: [EVENTBRITE], [TICKETMASTER], [ICAL].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Eventbrite event/ticket | Event URL or selected pass; date/venue/source | Permissioned event metadata; sold-out/cancelled/rescheduled state and ticket vs public event separation |
| Ticketmaster event/ticket | Public listing or private supplied ticket | Appropriate event-discovery interface; seat/transfer/redemption remains private and inactive |
| Meetup event/group | Selected event details | Current authorized lookup; no join/RSVP or member-list collection |
| Facebook Event | Supplied event details | Explicit permitted page/API route; no assumed group access |
| DICE / Resident Advisor / Bandsintown event | Listing or supplied ticket/screenshot | Normalize artist/venue/occurrence/timezone; current interface verification before automation |
| ICS download / calendar subscription | Parse occurrence candidate | Recurrence/exceptions/cancellation and `UID`/version; no auto-subscription or RSVP |

A concert's doors time, show time and ticket scan time are not necessarily the same. Store which field was actually supplied.

### 11.7 Wikiloc / AllTrails / Komoot / Outdooractive

**Status:** Komoot export/import help reviewed; other apps export-first. Reference: [KOMOOT].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Wikiloc trail | Link + supplied GPX/screenshots | Route summary, elevation and source date if permitted; no guarantee of current safety/access |
| AllTrails trail/list | Bookmark or permitted route export | Selected route details and constraints; no subscription bypass |
| Komoot route/activity | Supplied GPX or selected exported route | Route/time/elevation with photo/text relationships; respect private regions/home points |
| Outdooractive tour | Supplied route/description | Bounded spatial processing; live conditions and safety require separate current evidence |

## 12. Shopping, food, homes and money

### 12.1 Amazon

**Status:** current official docs redirect old PA-API material to Creators API migration. References: [AMAZON], [AMAZON-CREATORS].

| Type | Basic | Advanced |
| --- | --- | --- |
| Product / short affiliate link | Preserve final product identity and original link privately; selected specs/price screenshot | Current approved catalog integration, exact ASIN/variant/marketplace/currency and observation time |
| Wishlist/list | Selected items/reference | Explicit bounded permitted import; no account-library scraping |
| Review/Q&A/video | Selected supplied text/media | Attribution and independent specification checks; no blanket review/AI reuse permission |
| Order/invoice/return label | Sensitive supplied receipt/PDF | Purchase/warranty/return-date extraction; no order history access or return initiation |
| Kindle/Audible link | Bibliographic bookmark | Licensed supplied excerpt/file only; no DRM removal |

Do not propose Product Advertising API 5 as a fresh integration from old tutorials: the current official notice says it is deprecated/replaced by Creators API. Eligibility, credentials, permitted use, cache/attribution rules and whether the desired AI workflow is allowed still need review. A catalog API response is not automatic permission to ingest everything into memory.

### 12.2 eBay / Etsy / AliExpress / Temu / SHEIN

**Status:** Etsy API docs readable; eBay overview returned 403. Reference: [ETSY].

| App/type | Basic | Advanced |
| --- | --- | --- |
| eBay listing/auction | Snapshot price, condition, end time and location | Verify licensed current API; total including shipping/tax, variant and auction state; no bidding |
| Etsy listing/shop | Supplied listing/reference | Scoped approved API if justified; materials/dimensions/variant and seller claims |
| AliExpress product | Selected specs/price/screenshots | Normalize variant/quantity/shipping/currency; no assumption that generic title price is the selected price |
| Temu / SHEIN product | Bookmark/supplied screenshot | Independent dimension/material comparison; no app-only checkout automation or anti-bot bypass |
| Order/tracking/return | Selected receipt and carrier reference | Due/return/warranty candidates; no payments, refunds or carrier account access |

### 12.3 Retailer sites / Shopify stores / IKEA / Decathlon / app stores

**Status:** Shopify Storefront Product is documented, but each store controls access. Reference: [SHOPIFY].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Independent/Shopify product | Public permitted page or supplied listing | Licensed structured product data, variant/stock/price source time |
| IKEA / Decathlon / specialist retailer | Bookmark and selected specifications | Compare exact SKU, dimensions, compatibility, delivery market and total |
| App Store / Google Play app | App link and supplied description/screenshot | Permissions/privacy/version and independent reviews where permitted; no installation or purchase |
| Browser extension / software download | Inert product/reference | Static risk/context summary; no downloading/installing executable code by default |

### 12.4 Vinted / Depop / Wallapop / Subito / Facebook Marketplace / Craigslist

| App/type | Basic | Advanced |
| --- | --- | --- |
| Vinted / Depop listing | Item snapshot, size/condition/asking price | Compare against owner criteria; messaging/contact/payment remain separate |
| Wallapop / Subito listing | Supplied description/photos/location | Dimensions/model identification with uncertainty; protect seller contact details |
| Marketplace / Craigslist listing | Link and selected supplied evidence | Scam-risk indicators framed as uncertainty, not identity verification; no contacting seller |
| Saved search/price watch | Save criteria only | Explicit monitoring interval, allowed source and notification policy; not automatic after one shared listing |

### 12.5 Recipes, restaurants and groceries

| App/type | Basic | Advanced |
| --- | --- | --- |
| GialloZafferano / BBC Good Food / Serious Eats / recipe blog | Permitted recipe text with source and servings | Structured ingredients/quantities/steps/time; distinguish author recipe from user comments |
| NYT Cooking / other subscription recipe | Bookmark and permitted supplied excerpt/export | No paywall bypass; authorized supplied representation only |
| Cookpad / Samsung Food / Paprika | Selected recipe/export | Import supported recipe schema; preserve edits as owner adaptations, not original author text |
| Instagram/TikTok/YouTube recipe | URL plus supplied permitted video/images | Speech+overlay+demonstration extraction; missing quantities stay unknown |
| Uber Eats / Deliveroo / Just Eat / DoorDash menu | Supplied menu/order | Snapshot pricing/allergens and receipt; no checkout or allergy guarantees |
| Supermarket list/product/receipt | Text/photo/CSV | Barcode/product variant, unit pricing and explicit shopping-list candidates; OCR totals verified |
| Wine/beer/food label | Photo and owner note | OCR producer/vintage/ingredients/lot and personal tasting note; allergen uncertainty visible |

Scaling servings requires units and a deterministic arithmetic check. Food safety/allergen advice needs caution; a reel without measurements is not a complete recipe.

### 12.6 Homes and property: Idealista / Immobiliare.it / Rightmove / Zillow / Realtor.com

| App/type | Basic | Advanced |
| --- | --- | --- |
| Property listing | Snapshot price/location/area/rooms and source time | Normalize units, fees, floor plan and selected listing comparison |
| Floor plan / EPC / cadastral PDF | Preserve original; visible text/plan | Specialized dimensions/layout reading with uncertainty; not a professional survey or legal title check |
| Rental agreement/offer | Sensitive supplied document | Date/obligation extraction with source clauses; no signing, application, deposit or contacting agent |
| Saved search | Store explicitly stated criteria | Authorized bounded monitoring only if separately requested; no continuous location profiling |

### 12.7 Banking, payments, expenses and crypto

| App/type | Basic | Advanced |
| --- | --- | --- |
| Bank app / Revolut / Wise / N26 statement | Selected redacted PDF/CSV/receipt | Read-only transaction reconciliation and recurring-charge candidates; no credentials or live bank session borrowing |
| PayPal / Stripe / Square receipt/invoice | Supplied receipt | Merchant/currency/tax/due-date extraction; no paying or approving invoice |
| Splitwise / Tricount expense | Selected export/screenshot | Participant balances with exact arithmetic and source; no settlement transfer |
| Wallet payment/crypto address/QR | Display inertly, identify sensitivity | Never sign, connect wallet, approve token spend or send funds from attachment contents |
| Account number / card / seed / recovery code | Do not index/model by default | Dedicated protected secret handling only, not normal attachment memory |
| Price/market chart | Supplied chart and observation time | OCR axes/units and source comparison; not real-time data or investment advice |

## 13. Books, entertainment, fitness and personal records

### 13.1 Goodreads / StoryGraph / LibraryThing / Google Books / Kobo / Kindle

**Status:** export-first; Goodreads help returned a loading shell, so no current public-API claim is made. Bibliographic alternative: [OPENLIBRARY].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Goodreads / StoryGraph / LibraryThing book | Link, title/author and owner's note | Resolve edition/ISBN through permitted metadata; selected reading-list export |
| Google Books preview | Bibliography and permitted selected passage | Quote/edition locator; preview availability is not a full-book license |
| Kindle highlight/notebook/clipping | Owner-supplied quote plus note | Preserve book/edition/location; limits/licensing respected; no account scrape/decryption |
| Kobo highlight/export | Selected exported text | Edition/page/locator and owner annotation separated |
| Ebook/PDF/book scan | Authorized supplied file | Chapter/page retrieval, OCR and citations within format/rights limits |

“Remember this book” normally means a reading-list candidate, not “I have read it” or “I agree with every claim.”

### 13.2 Audible / audiobook apps / Libby / Hoopla

| App/type | Basic | Advanced |
| --- | --- | --- |
| Audible title/clip | Bookmark and supplied permitted notes/excerpt | Authorized local excerpt/transcript only; no DRM removal or full-library download |
| Libby / Hoopla title/loan | Book identity and manually supplied due date | Reminder proposal if explicitly requested; no library-account borrowing/renewal or decrypted audiobook access |
| Public-domain audiobook / LibriVox | Licensed source/reference | Authorized chapter audio → ASR if useful; verify edition and reader attribution |

### 13.3 IMDb / TMDB / Letterboxd / Trakt / JustWatch / streaming apps

**Status:** TMDB documentation readable; Trakt page returned a shell. Reference: [TMDB].

| App/type | Basic | Advanced |
| --- | --- | --- |
| IMDb / TMDB movie/show/person | Link and owner note | Licensed metadata resolution; title/year/season/episode disambiguation |
| Letterboxd / Trakt review/list | Selected supplied text/list export | Watchlist organization; review belongs to its author and doesn't imply owner agreement |
| JustWatch availability | Snapshot country/service/time | Current licensed regional availability check if configured; not a timeless fact |
| Netflix / Disney+ / Prime Video / Apple TV / Max | Title/episode reference and supplied notes | No DRM capture/transcription; use permitted trailers/transcripts or independent metadata |
| Trailer / scene clip | Link or permitted supplied file | Video analysis only within rights; full episode/movie is not implied |

### 13.4 Gaming: Steam / GOG / Epic / itch.io / console apps / BoardGameGeek

| App/type | Basic | Advanced |
| --- | --- | --- |
| Steam / GOG / Epic / console store game | Product link and owner note | Compare platform/version/requirements and current observed price; no purchase/install |
| itch.io project | Product/reference | Inert docs/media analysis; executable download is not safe to run automatically |
| BoardGameGeek game/list | Supplied title/rules excerpt | Licensed metadata or supplied rules PDF; distinguish edition/expansion |
| Game clip/screenshot | Supplied image/video | OCR/settings/context and allowed media analysis; no account credentials or anti-cheat bypass |
| Save file/mod/archive | Opaque or bounded manifest | Specialized read-only inspection only when justified; no loading mods/scripts |

### 13.5 Strava / Garmin / Komoot / TrainingPeaks / Runkeeper / Nike Run Club

**Status:** Strava activity API, current agreement and API policy reviewed; the ordinary API is **not a general AI/memory ingestion route**. References: [STRAVA], [STRAVA-AGREEMENT], [STRAVA-POLICY].

| App/type | Basic | Advanced |
| --- | --- | --- |
| Strava activity/segment/route | Keep an owner-supplied reference; independently originated permitted device exports are a separate source | Current policy prohibits ordinary API data in AI context, embeddings/RAG and persistent indexes; evaluate only the specifically documented personal-use Strava MCP exception, without assuming it allows durable memory |
| Garmin Connect activity/report | Selected export | FIT/TCX/CSV parser with units, heart-rate/time-series privacy and source version |
| Komoot route/activity | Selected permitted GPX | Spatial summary and route notes, excluding private start/end points where appropriate |
| TrainingPeaks plan/workout | Selected file/text | Distinguish planned from completed session; no editing coach plan automatically |
| Runkeeper / Nike Run Club activity | Selected export/screenshot | Current interface verification; no silent fitness-history import |

**Strava-specific finding:** the reviewed policy prohibits ordinary API data and derivatives in AI operation, context windows, embeddings, evaluation and RAG, and separately prohibits persistent retrieval indexes/archives. It documents a narrow exception for personal use through the official **Strava MCP** interface, subject to its requirements and other restrictions. That is not proof Pico has access or that indefinite memory retention is permitted. The agreement also limits disclosure to the relevant athlete and requires privacy/deletion controls. Do not bypass these limits by proxying API results through a generated export or model summary.

Workout routes expose routines/home; heart rate and performance can be health data. A local export is not a universal waiver of source terms or third-party privacy.

### 13.6 Apple Health / Health Connect / Fitbit / Oura / WHOOP / Withings / MyFitnessPal / Cronometer

**Status:** export-first and sensitive. The Apple Health authorization page tested returned only a shell, so no current app-level integration is claimed.

| App/type | Basic | Advanced |
| --- | --- | --- |
| Apple Health / Health Connect record/export | Explicit selected export or screenshot | Device-scoped permissioned design only if implemented; units, sample source/device and duplicate samples |
| Fitbit / Oura / WHOOP / Withings report | Selected report/export | Narrow current API consent if justified; timezone/baseline/missing data and algorithm-version context |
| MyFitnessPal / Cronometer meal/nutrition | Supplied text/CSV/screenshot | Serving units, ingredient assumptions and deterministic totals; no allergy/medical guarantees |
| Sleep/ECG/lab/clinical PDF | Sensitive selected original | Source-aware trend extraction and explicit uncertainty; not diagnosis or emergency monitoring |

Do not automatically embed/index the entire health export or send it to a general model provider. A minimal “remember to discuss this result with my doctor” note can be more useful and less invasive than a full health-data integration.

### 13.7 Photos, scanners and personal records

| App/type | Basic | Advanced |
| --- | --- | --- |
| Apple Photos / Google Photos / Samsung Gallery image | Shared pixels or original file; caption | OCR/description, date only from actual supplied metadata, duplicate detection; cloud-link access not assumed |
| Google Photos album / iCloud shared album | Selected images/reference | Explicit selected album export; link may be capability/private and items can expire/change |
| Immich / PhotoPrism / Synology Photos | Selected originals | Verify explicit self-hosted read API and privacy; no host filesystem or face-library access by default |
| Adobe Scan / Microsoft Lens / iOS Scan Documents / CamScanner | PDF/JPEG originals | Multi-page OCR, deskew and searchable PDF; never assume scanner app already supplied searchable text |
| Handwritten note/whiteboard/business card | Original image and visible-text uncertainty | Region-aware OCR and structured candidates, with uncertain names/numbers visible |
| Certificate/warranty/insurance/contract | Sensitive PDF/image | Expiry/due date/obligation candidates with exact clauses; not legal validation or implicit renewal/cancel |
| Pet/vet/school/family record | Selected file | Source-aware organization and requested reminders; minimize third-party/minor data |

Apple documents choices to remove location when sharing photos. Pico only knows metadata actually received; a photo share may be transformed before the bot sees it. [EXIF-PRIVACY] [EXIFTOOL]

## 14. Regional, specialist and long-tail apps

These entries deliberately remain **export-first proposals** unless otherwise noted. Their current first-party read APIs, export fidelity and terms were not individually validated. A maintained downloader containing an extractor is not a platform endorsement. [YTDLP-EXTRACTORS]

| App/service | Distinct things you may share | Basic | Advanced, only after access/rights verification |
| --- | --- | --- | --- |
| Bilibili | Video, multi-part video, dynamic post, article, playlist | Link plus supplied text/transcript/media | Per-part ASR/OCR, subtitles, chapter identity; bullet comments separated from creator content |
| Douyin | Short video, slideshow, live, shop product | Link/screenshots/allowed export | Speech+overlay+scene extraction; product link treated independently |
| Xiaohongshu / RED | Photo/text note, carousel, video, product/place recommendation | Supplied caption/images | Ordered OCR, ASR, attributed recommendation and external corroboration |
| Kuaishou | Short video/live/product | Supplied media/link | Authorized bounded video analysis; no background live capture |
| Weibo | Text post, image set, video, repost chain | Selected text/images | Repost/source chain and media analysis with missing-context markers |
| WeChat Official Accounts | Article, images, audio/video | Readable permitted article or supplied export | Structured article plus permitted media; mini-program pages are a different object |
| Zhihu | Question, answer, article, paid column | Selected text/link | Bounded attributed Q&A; no paid-column bypass |
| Naver Blog / Naver Cafe | Blog, member post, photo set | Readable public page or chosen export | Korean OCR/structure; member access remains separate |
| Kakao / Daum / Brunch | Article, blog, chat card, venue | Selected text/images/link | Source-aware article/entity extraction; no app-session access |
| LINE VOOM | Video/post/profile | Link or supplied media | Authorized multimodal extraction; Official Account webhook is not the feed API |
| VK | Post, video, music, document, discussion | Link/supplied material | Verify current scoped interface/terms; no music ripping or private-community bypass |
| OK.ru | Post, video, live | Link/export | Bounded permitted video pipeline |
| Rutube | Video/channel/live | Reference and supplied transcript/file | Verify authorized captions/media path; no reliability assumed |
| Telegram channels | Forward, public post link, album, paid post | Actually forwarded content/reference | Permitted supplied-media processing; a bot is not a general MTProto history client |
| Rumble / Odysee / BitChute | Video/channel/live | Reference and supplied excerpt | Current permitted source verification; speech+visual analysis; claims remain attributed |
| TED / TEDx | Talk, transcript, translation | Available permitted transcript/link | Timestamped talk/slide analysis and language provenance |
| Nebula / Floatplane / Patreon / Ko-fi | Member video, paid post, file, creator feed | Bookmark or permitted supplied excerpt/export | No subscriber-session borrowing, DRM removal or membership bypass |
| Patreon / Memberful podcast feed | Tokenized private RSS | Private bookmark and selected allowed transcript | Explicit token-safe scoped integration if terms permit |
| Behance / Dribbble / ArtStation | Project, image series, animation, design case study | Supplied image/project text | Ordered visual/OCR analysis with creator credit; no model-training or reuse license assumed |
| DeviantArt / Pixiv | Artwork, comic, animation, member content | Reference or supplied allowed image | Authorized selected OCR/description; no private/age/paywall bypass |
| Flickr / 500px / Unsplash / Pexels | Photo, album, license page | Original/reference plus creator/license | Selected metadata/description and license-aware reuse; attribution requirements retained |
| SoundHound / Shazam | Song identity/link | Owner-supplied title/link | Independent licensed catalog resolution; recognition result is not audio-use permission |
| Genius / Musixmatch | Song/lyrics page | Reference or permitted short supplied quote | No unrestricted lyric extraction/reproduction; licensed interface only |
| Discogs / MusicBrainz / Rate Your Music | Release, artist, collection/review | Bibliographic/music bookmark | Verify current metadata license, release/pressing identity and selected collection export |
| Setlist.fm / Songkick | Set list, concert, artist alert | Selected event/set-list text | Licensed current interface and event-time context; no automatic follow subscription |
| Untappd / Vivino / CellarTracker | Beer/wine/product/tasting note | Photo/link and owner's note | Product/vintage/serving disambiguation; personal consumption data minimized |
| Fragrantica / Parfumo | Fragrance/product/review | Bookmark and supplied notes | Attributed note/variant comparison; no review scraping entitlement |
| Reverso / DeepL / Google Translate | Selected translation, dictionary entry | Original and translated text separately | Preserve language pair and uncertainty; translation is a derivative, not new source evidence |
| Notability / Goodnotes / Nebo | Handwritten note, annotated PDF, notebook | Selected PDF/images | Handwriting and annotation extraction, page lineage; native package support separately verified |
| Roam / Tana / Capacities / Anytype / AFFiNE | Note/block/object/graph | Selected text/export | Bounded graph/object import; links and backlinks do not justify importing all private knowledge |
| Coda / Airtable / Baserow / NocoDB | Doc/table/view/record | Selected CSV/PDF/text | Scoped read, view/filter/row identity, attachments; formulas/live automations not executed |
| Tableau / Power BI / Looker Studio / Grafana | Dashboard, chart, filtered report, exported data | Screenshot/PDF/CSV plus filter/time context | Authorized selected-data read; retain axes/units/filters and distinguish rendered aggregate from underlying complete dataset |
| Mathematica / MATLAB / RStudio / Jupyter | Notebook, script, data, plot, model file | Inert text/plot/data manifest | Specialized selected outputs and schema inspection; no notebook execution, package installs or unsafe serialized-object loading |
| ClickUp / Monday / Basecamp | Task/doc/project/message | Selected export/text | Verify tenant read API; source status vs proposed local action separated |
| Calendly / Cal.com / Doodle | Booking page, confirmed appointment, poll | Selected supplied slot/confirmation | Parse timezone and occurrence; never book, vote or disclose availability automatically |
| Weather apps | Forecast, warning, radar screenshot | Source/time/place and supplied details | Current licensed forecast/warning data only if configured; screenshot forecast can be stale |
| Flighty / FlightRadar24 / FlightAware | Flight/reference/status screenshot | Flight/date/source time | Licensed authorized status lookup; operational status not inferred from itinerary alone |
| Polarsteps / TripIt / Wanderlog / Roadtrippers | Trip, itinerary, stop list | Selected itinerary export | Segment/place timeline with private-location minimization; no tracking subscription |
| PackPoint / Bring! / AnyList / OurGroceries | Checklist/list/recipe | Selected list text | Stable checklist items and quantities; no remote sync or purchase by default |
| Yuka / Open Food Facts / INCI Beauty | Barcode/product/ingredient rating | Supplied label/product reference | Licensed ingredient lookup; app score is an attributed assessment, not medical fact |
| Too Good To Go / Flashfood | Offer/collection window/receipt | Selected offer/details | Deadline/place candidates; no purchase or store-contact action |
| Vinted-like local markets / auction sites | Listing, bid, seller note | Snapshot/reference | Approved monitoring only when explicitly requested; no bid/contact/payment |
| Printables / Thingiverse / MakerWorld / Thangs | Model, STL/3MF, assembly instructions | Reference and selected inert file | Bounded geometry/units and instruction extraction; no slicer plugins, G-code execution or printer action |
| Instructables / Hackaday | Tutorial, images, parts list | Permitted article/file | Step/order/material extraction; safety limitations and linked executable code kept distinct |
| Arduino Project Hub / Hackster | Project/code/wiring | Inert selected docs/code | Diagram/parts extraction; never flash hardware or execute scripts |
| Museum/archive/library collections | Item, scan, IIIF manifest, catalog record | Metadata/selected licensed image/text | IIIF-aware selected page OCR and provenance/license preservation |
| Government portals | Notice, form, tax/benefit PDF, deadline | Selected original and publication date | Exact clause/date extraction; no portal login, filing or electronic signature |
| Legal/case-law databases | Judgment/statute/commentary | Permitted selected text/source date | Jurisdiction/version/citation aware reading; no claim of legal advice or current validity without verification |
| Employment portals / Indeed / Glassdoor / Greenhouse / Lever | Job, review, application status | Selected listing/confirmation | Requirements/deadline comparison; employer reviews attributed; no applying/contacting/uploading CV |
| CRM/address-book apps | Contact/company/deal card | Selected fields/export | Explicit narrow read integration if justified; no outreach or mass-contact import |
| Smart-home/security apps | Screenshot, device log, camera clip | Selected inert evidence | Bounded local analysis; never unlock doors, change devices or start surveillance from attachment content |
| Car/EV apps | Charging receipt, route, diagnostic report | Selected file/text | Units/time/source-aware summary; no remote vehicle command or inference of driver identity |
| Geocaching / geolocation games | Cache/place/track reference | Selected coordinates/text | Respect private locations, game rules and safety; no continuous movement tracking |
| Adult/dating/private community apps | Profile/chat/media screenshot | Highly sensitive selected material, ideally minimal | No face identification, stalking, inferred sensitive traits, bulk profile collection or consent bypass |
| Any new app or unsupported domain | URL, file, structured share or opaque object | Classify actual transport; keep source and owner's note; report limitations | Reuse recipes A–H; specialized integration only after repeated need, access review and tests |

## 15. What to remember, what merely to retain, and how to reply

### 15.1 Separate five layers

1. **Original evidence:** actual received file/text or authorized source capture, plus immutable identity/hash/revision.
2. **Extracted representation:** OCR/transcript/article text/structured fields, with method, model/version, language and coverage.
3. **Interpretation:** summary, inferred tags, entity links and proposed tasks. Model-authored and fallible.
4. **Owner intention:** “save this,” “I like this,” “remind me,” “compare these.” Preserve separately from quoted media speech.
5. **Action/receipt:** a saved note, list mutation or reminder exists only when its canonical service confirms it.

A saved attachment is not a personal fact. “Someone recommends supplement X” must not become “the owner takes X.” A highlighted passage is not agreement. “This flight leaves at 8” from an old screenshot is not a current itinerary confirmation.

### 15.2 Suggested capture modes

These are proposed product semantics, not new commands already implemented.

| Owner intent | Retain | Derive | Do not silently do |
| --- | --- | --- | --- |
| “Save for later” | Reference/original and minimal searchable label | Optional cheap title/type classification | Full paid transcription, subscribe, monitor or memorize every claim |
| “Remember this” | Source and reason; useful representation if accessible/permitted | Short source-linked note and relevant tags | Treat external claims as owner beliefs or instructions |
| “What's in this?” | According to conversation retention policy | Bounded explanation with coverage/uncertainty | Unrequested long-term personal facts or account sync |
| “Notice anything important?” | Source and observations | Dates, warnings, missing fields and candidate follow-ups | Create reminders/events or contact anyone solely because source text suggests it |
| “Extract the recipe/steps” | Original plus attributed structured result | Ingredients, quantities, sequence, prerequisites and explicit gaps | Invent missing measurements or say visuals were read when only audio was analyzed |
| “Add this to my list” | Source-linked actual list mutation | Canonical item and receipt | Duplicate an item on uncertain acknowledgment |
| “Remind me Friday” | Explicit owner request and linked source | Actual reminder through existing authorized service | Infer an ambiguous timezone/deadline or equate an event with an alert |
| “Track this price/event” | Explicit watch definition, if implemented | Bounded authorized periodic reads and change notifications | Start permanent polling after an ordinary bookmark |
| Caption-less share | In an explicitly opted-in inbox, minimal saved reference/original | State unknown intent; optionally classify | Infer preference, execute embedded instructions or enable metered services |

Routine local writes retain Pico's existing delegation model; this proposal does not add a confirmation prompt for every note. Ambiguous or consequential values still need clarification in later use. This research task itself does not enable capture defaults.

### 15.3 A useful source card

Prefer a compact record linked to existing documents/receipts, not a second unconnected database:

- Original share and resolved canonical identity; source app/domain; selected timestamp/range.
- Owner annotation, supplied text and attachment ordering.
- Author/publisher as reported, publication/event time, receipt/fetch time and timezone.
- Original/document/revision IDs and hashes; parent/quote/repost relations.
- Available components: body, caption, comments, slides, audio, subtitles, frames, assets.
- Processing method/version and provider, languages, success/partial/unavailable/uncertain state.
- Coverage: pages/slides/items/segments processed, missing parts and truncation.
- External-content provenance; personal fact vs inferred interpretation clearly separated.
- Sensitive/capability status, retention/erasure lineage and permitted-use constraints.
- Optional domain fields: recipe servings; product variant; event timezone; place ID; paper DOI/version.

**Do not collapse status to one “processed” bit.** A reel could have caption `complete`, audio `failed`, frames `not attempted`, overall `partial`. A successful transcript can cover 03:00–05:00 without covering the whole hour-long video.

### 15.4 Phone-sized replies

Examples of the desired future UX, **not claims these integrations have been implemented**:

> Saved to your cooking inbox. Read the 6 supplied carousel images; quantities extracted from slides 2–3. One word on slide 4 is unclear. Original post linked.

> Saved the YouTube link at 12:43. I do not have an authorized transcript or video file, so this is a bookmark only—not a summary of the video.

> Transcribed the supplied 42-second clip and read its visible instructions. Saved a 5-step note. No temperature was given, so I left it unknown.

> Saved the event reference: 24 October, 20:00, Europe/Rome, from your ticket. No reminder created.

> Saved the article's headline and your note. The body is behind a login; I have not read the full article.

Use one useful final receipt, not a flood of generic “received” messages. Pico's current typing/draft/reaction behavior remains as documented; a reaction is not a completion receipt.

### 15.5 Retrieval and forgetting

- Search original text **and** source-linked OCR/transcripts/notes; a short summary alone loses names, measurements and exceptions.
- Support later questions such as “the silent reel with the wall shelf,” “the Rome restaurant I saved last month,” or “that podcast clip about sleep,” without claiming a feature is live before its representations/indexing are implemented.
- Attach citations to real stored spans; future media citations need item/page/time/region locators. Current Pico document citations refer to extracted representation lines/offsets, not original PDF page coordinates.
- Deduplicate canonical identity and byte hashes while preserving separate owner annotations and capture versions. Similar thumbnails or text are not enough to merge different posts.
- Deleting/forgetting must cover original plus transcript/OCR/frames/embeddings/summaries, linked derived records and managed backups, using Pico's existing source/tombstone model.
- External Telegram/provider/downloaded copies remain outside Pico's erasure guarantees. Do not silently re-fetch a forgotten URL or re-publish late job results.

## 16. Implementation plan and tool choices

### 16.1 Smallest complete architecture

**Do not implement this research by generating a skill per site.** Most of the value comes from a few shared pipelines.

1. **Existing Telegram intake:** retain authentication, stable admission IDs, original bytes and ordered context.
2. **Classifier/resolver:** identify actual transport, canonical provider/object and available components. Resolve safe redirects, not arbitrary app URI handlers.
3. **Acquisition policy:** determine whether the item is public, private/capability, owner-supplied, paid/DRM, blocked or unsupported; enforce provider-specific permitted use **before** content enters models or durable indexes.
4. **Shared processors:** existing document conversion, text extraction, OCR, permitted ASR, video probing/frames and specialized structured readers only where justified.
5. **Existing canonical knowledge/memory services:** publish source-linked immutable representations and authored notes; do not create an independent archive with broken forgetting.
6. **Phone receipt:** actual coverage, useful result, saved identity and unavailable/uncertain components.

Use a standard private-instance skill for a bounded reusable procedure; use trusted extensions for persistent channels/connectors/lifecycle jobs. Neither runs in a security sandbox. Hard network/resource isolation, if required, needs an explicitly designed whole-worker/OS boundary, not a reassuring class name. See [skills](SKILLS.md), [SDK](SDK.md), [security](SECURITY.md).

### 16.2 Recommended phases

| Priority | Scope | Why / completion criterion |
| --- | --- | --- |
| P0 | Honest component outcomes and mobile source receipts | Never claim saved/read/transcribed/watched interchangeably; current gaps are visible |
| P1 | Finish common upload pipeline: supported audio-as-document, image/scan OCR, PDF page coverage, bounded video probe/audio/frame extraction | Works across Instagram exports, WhatsApp recordings, receipts, tickets, tutorials and many future apps |
| P2 | Safe opt-in public-link capture into knowledge using existing web services | High value for articles, public docs, recipes and product references; no JS/cookies/recursive crawl by default |
| P3 | Permitted transcript/podcast workflow, then authorized YouTube/media sources | Prefer existing transcripts and selected excerpts; preserve timestamps and rights/access failures |
| P4 | Visual recipe/tutorial extraction from supplied authorized video/carousel | Combines speech, overlays and demonstrations; source-backed structured note with missing details |
| P5 | Selected account connectors with clear repeated need | Existing Google first; others only after API/terms/scopes/erasure and private setup are solved |
| P6 | Explicit monitoring and large-file alternatives | Requires scheduling, notification policy, storage budgets and separate operations; not implicit in capture |

**Not first:** universal browser automation, stealth scraping, residential proxies, personal-message session clones, whole-library imports, a local Telegram API server, or every app API in this catalog. These increase operational and security burden without solving the common content pipeline.

### 16.3 Tool comparison

No dependencies were installed and no tools were integrated for this research. These are candidates to evaluate, not a shopping list to add wholesale.

| Need | Basic/default candidate | Advanced candidate | Main trade-off |
| --- | --- | --- | --- |
| Office/document conversion | Pico's existing AnyDoc + native handlers | Evaluate Docling/MarkItDown/Tika for demonstrated gaps only | Avoid duplicate pipelines, different locators and unnecessary runtimes; inspect actual licenses/dependency terms |
| Public article extraction | Existing Pico web network/extraction | Readability/Trafilatura concepts or a targeted compatible parser | Extra framework is unnecessary if current extraction works; JS pages remain different |
| Media metadata/audio/frame extraction | FFmpeg + ffprobe | Bounded scene/text-aware selection around relevant changes | Mature tools, but decoders/filters/protocols are an attack surface; external fetches disabled for local-file jobs |
| Authorized media URL acquisition | Explicit publisher download/API/export | `yt-dlp` as a reviewed, constrained acquisition tool where allowed | Extractors break; rights, credentials, JS runtime, plugins and SSRF are independent concerns |
| Speech-to-text | Pico's existing explicitly enabled hosted transcription for supported audio | Local faster-whisper or whisper.cpp; WhisperX-style alignment/diarization only if needed | Hosted disclosure/cost vs local hardware/models/latency; language and noise quality need actual evaluation |
| OCR images/scans | Tesseract for legible local printed text | OCRmyPDF for PDF derivatives; layout/vision model for justified difficult content | OCRmyPDF creates a derivative, not semantic understanding; handwriting/tables need evaluation |
| Complex document layout | Existing extraction and honest warnings | Evaluate Docling on a fixed representative corpus | Larger model/runtime footprint; do not silently replace current provenance/citation behavior |
| Image/video semantic understanding | Configured bounded vision model on selected images | Multimodal timed frames + text/audio fusion | Provider disclosure/cost, hallucination and incomplete temporal coverage |
| Metadata | Bounded ExifTool-style inspection if needed | Domain-specific parser for repeated need | Location/device details are sensitive; parsing metadata does not verify truth |
| Antivirus/static file scanning | Reject or preserve unsupported files according to policy | ClamAV/static scanning as defense in depth | Scanner “clean” is not safe execution or comprehensive malware detection |
| Browser-only authorized pages | Export-first | Playwright in a deliberately isolated, explicit account workflow if justified | Script execution, cookies, downloads, subrequests and actions expand authority; not a drop-in replacement for safe web fetch |
| Search/retrieval | Existing canonical Store/QMD and provenance | Media/page/time locators in linked representations | Summary-only indexing hurts exact recall; new representations must honor erasure |

References: [ANYDOC], [DOCLING], [MARKITDOWN], [TIKA], [READABILITY], [TRAFILATURA], [FFMPEG], [FFPROBE], [YTDLP], [WHISPER], [FASTER-WHISPER], [WHISPERCPP], [WHISPERX], [TESSERACT], [PDF], [EXIFTOOL], [CLAMAV], [PLAYWRIGHT].

**Specific downloader caveat:** current `yt-dlp` documentation recommends FFmpeg/ffprobe and, for full YouTube support, `yt-dlp-ejs` plus a supported JavaScript runtime. Old “install one binary and YouTube works forever” recipes are not dependable. Do not auto-download remote runtime components/plugins or import the owner's browser cookies to repair a failure. Tool support is not a permission grant.

**Specific ASR caveat:** hosted speech services have model-specific input formats, request sizes, timestamps/diarization options and billing. OpenAI's reviewed file-transcription guide states a 25 MB upload limit, but Pico's own intake remains lower and its current transcription call does not implement every advanced output. Pin/verify the chosen model's current contract rather than copy every advertised feature into Pico's capability claims. [OPENAI-STT]

### 16.4 Job semantics and resources

For any future queued extraction:

- Commit original/source identity and intention before externally billed/effectful work; track pending, running, succeeded, partial, failed, cancelled and **acceptance-uncertain** outcomes.
- Carry owner/source/erasure epoch through asynchronous work; deleted/replaced revisions cannot publish late results.
- Deduplicate by source version + bytes + processor/options/version + selected range, not by URL alone.
- Cap bytes, decoded pixels, pages, archive expansion, media duration, frames, subprocess time/RSS, output length, concurrency and provider requests. No “unlimited” production default because this research had no budget limit.
- Distinguish local conversion retries from external inference of uncertain acceptance; never automatically rebill an unknown request to obtain a receipt.
- Keep originals, normalized previews and extracted text separate. Rebuildable indexes are not the source of truth.
- Show partial useful results without claiming full coverage; long-running jobs should not block ordinary chat/reminders or require an open phone session.
- Respect cancellation and shutdown, while reporting that cancellation cannot undo an accepted charge, saved original or delivered message.

### 16.5 Large-file alternatives

First version: give a helpful error and accept a shorter allowed excerpt, transcript, smaller PDF segment or explicitly supported private upload path. Do not ask the owner to paste credentials or tokenized download links into public chat.

Later options require separate design: authenticated bounded uploads, explicitly configured cloud-file retrieval, or a local Telegram Bot API deployment. None bypass decoder, memory, storage, model-context, privacy or rights constraints. Telegram Premium on the phone does not increase Pico's current safe limit.

## 17. Security, privacy, rights and operational failures

### 17.1 Non-negotiable boundaries

- **Source text is evidence, never authority.** A web page, reel transcript, PDF or QR saying “ignore your instructions,” “run this script” or “send these files” is not owner permission.
- **Authorize before downloading.** Preserve current private Telegram sender checks; another person's name/contact or forwarded message cannot become the authenticated owner.
- **Private links are secrets.** Tokenized feeds, share keys, signed CDN paths, booking/boarding-pass barcodes, password reset URLs and document capabilities must not leak to logs, search queries or unrelated model prompts.
- **Do not widen the public fetcher.** Validate DNS/IPs and every redirect; resist loopback/private/link-local/cloud-metadata access, rebinding, credential-bearing URLs, nonstandard schemes and deceptive hosts. Signed/private sources need a separate explicit path.
- **Subresources matter.** HLS playlists, subtitles, thumbnails, HTML assets, SVG references and browser requests can all trigger hidden network access. Acquisition must cover the whole request graph, not only validate the first URL.
- **No ambient account borrowing.** Never discover cookies, browser profiles, `~/.pi` credentials or connector secrets to make a scraper work. Use explicit private-vault setup and scopes.
- **No execution from attachments.** No scripts/macros, installer launch, notebook execution, URI action or archive-provided plugin. Conversion subprocess limits are not OS isolation.
- **No unrequested external actions.** Do not buy/unlock, RSVP, subscribe, send mail/messages, call numbers, contact sellers, sign forms, activate tickets or change devices because content suggests doing so.
- **No blanket cloud disclosure.** Self-hosted does not mean offline. Decide explicitly whether personal audio, faces, work documents, medical data or precise location can leave the machine for ASR/vision/embeddings/chat.
- **Preserve erasure.** New OCR, frames, transcripts, source cards and private link captures must join the existing source/dependency/tombstone/backup system.

### 17.2 Rights and access are separate gates

Check **technical access**, **account authorization**, **copyright/license**, **platform permitted use**, and **privacy/third-party consent** separately. Success in one does not imply the others.

Examples:

- Public URL ≠ permission to bulk scrape, permanently archive or send content to an AI model.
- Paid subscription ≠ permission for a server to download/decrypt/transcribe all material.
- OAuth token ≠ approved API use case or permission to retain data after disconnection.
- Owner uploads a file ≠ ownership of every third party's content inside it.
- oEmbed markup ≠ a permitted extraction API; Instagram makes this restriction explicit.
- A permissively licensed downloader ≠ permission to use each platform/content it can download.
- `robots.txt` is a crawler convention, not an authentication or authorization mechanism; respect it without treating it as a complete rights analysis. [ROBOTS]

The appropriate technical fallback is often a minimal bookmark plus explicitly supplied permitted material, not an escalating chain of mirrors, bypasses and account cookies.

### 17.3 Failure matrix

| Failure | Honest response / recovery |
| --- | --- |
| Login required/private | Save reference only if appropriate; use selected export or explicit connector, not borrowed login |
| Paywall/DRM/locked media | Do not bypass; bookmark or process permitted supplied material |
| 403/CAPTCHA/rate limit | Report blocked/rate-limited; bounded policy-compliant retry only when definite and appropriate; no proxy/stealth arms race |
| Deleted/expired/story gone | Keep reference and previously retained permitted evidence; do not reconstruct unseen contents |
| Redirect/SSRF validation refused | Explain source could not be safely opened; no “try less safe downloader” fallback |
| Unsupported codec/format | Preserve opaque original if policy allows; provide compatible-format/export suggestion |
| Audio absent/muted/silent | No transcript claim; use frames/text if available |
| Low-quality/overlapping speech | Partial transcript with uncertain spans; no invented names, amounts or negations |
| OCR unreadable | Mark specific regions/pages unclear; offer clearer original/crop as a future option |
| Truncated article/thread/carousel | List available/processed components and missing coverage |
| Dynamic ad/time mismatch | Cite analyzed version/time range; do not promise player offsets match every service |
| Live price/schedule changes | Include observation time; recheck only when requested/authorized |
| File too large/too long | No partial silent first-page/first-minute success; give excerpt/compatible-path options |
| Inference timeout/lost acknowledgment | Acceptance uncertain; do not automatically resubmit and potentially double-charge |
| Duplicate share | Reuse eligible source representation; keep new owner annotation; do not duplicate actions |
| Cancellation/deletion while processing | Stop later work and refuse stale publication; accepted external effects may already exist |
| Invalid or unverifiable citation | Withhold unsupported claim/locator; don't fabricate a source |
| Ordinary user message mixed with quoted malicious content | Execute only genuine owner request within existing authority; external text never grants tools/permissions |

## 18. Acceptance checklist and test corpus

Future implementation should use synthetic/licensed fixtures and disposable instances. Do not copy personal media, private chats, credentials, frozen evaluation gold or real boarding passes into repository fixtures.

### 18.1 Minimum regression cases

| Area | Representative success case | Essential denial/edge case |
| --- | --- | --- |
| Telegram admission | Authorized private photo/voice/file | Unauthorized sender rejected **before** storage/download; forwarded instructions remain evidence |
| Links | Plain URL, hidden entity, shortened URL, timestamp | Private token not logged/searched; malicious redirect/DNS/private IP refused |
| Source identity | Same video via short/watch/timestamp URL | Preserve selected ranges and separate owner notes; don't over-strip semantic query parameters |
| Text/article | Full readable article and supplied excerpt | Teaser/paywall/JS shell not labelled full body |
| Instagram | Synthetic supplied carousel/reel | No oEmbed-to-memory pipeline or claim of private story access |
| YouTube | Authorized transcript/file and timestamp | Captions permission failure, absent track and policy-restricted acquisition handled honestly |
| Reddit | Approved synthetic post/comment tree | Missing ancestors, pagination, deleted post and unapproved use do not become invented full thread |
| Spotify | Owner-supplied bookmark and independent publisher source | Restricted Spotify-derived content excluded from LLM/embeddings absent specific approval |
| Audio | Voice, audio field, audio-as-document, multilingual clip | No speech, bad codec, uncertain acceptance and cancelled request |
| Video | Speech+silent overlay+demonstration clip | Audio-only labelled as such; missing stream and unsampled regions visible |
| OCR | Digital scan, rotated image, mixed PDF | Tiny handwriting, huge pixel count, malformed image and page gaps |
| Documents | DOCX/PDF/CSV/Slides/XLSX | Tracked changes, hidden sheets, cached formulas, locked/encrypted document and unsupported format |
| Structured | ICS timezone/recurrence, VCF, route, ticket | No RSVP/contact/payment/activation; barcodes/capabilities protected |
| Bundles | Ordered images+caption, relative asset export | ZIP traversal/symlink/bomb, nested archive and partial album |
| Memory | “Save recipe” and “I like this place” | Third-party claim doesn't become owner belief or standing instruction |
| Effects | Confirmed note/reminder receipt | Lost acknowledgment not replayed; reminder not implicitly inferred from ticket |
| Erasure | Forget source and all managed derivatives | Late job publication, identical reimport and restore resurrection blocked |
| Retention | Durable original vs cache expiry | No claim cache cleanup erased knowledge/provider copies |
| Operations | Bounded large job and interruption/restart | Long processing doesn't starve reminders/chat; current supervisors/runtime boundaries respected |

### 18.2 Quality gates, separately measured

- **Acquisition:** authorized and permitted source fetched; correct item/version, not a preview.
- **Extraction:** text/speech/visual coverage and fidelity, including numerical values, names, language and missing regions.
- **Attribution:** correct author/speaker/source chain and owner-intent separation.
- **Retrieval:** can later questions find the source and the relevant evidence, not only its summary?
- **Answer support:** is the requested answer justified by the retained evidence and coverage?
- **Action correctness:** did the actual authorized note/list/reminder mutation occur, with no duplicate uncertain replay?
- **Privacy/erasure:** no unintended disclosure, persisted ephemeral content or resurrected derivatives.
- **Mobile experience:** readable short receipt, usable file/clip limits, actual Telegram rendering/delivery.

Use newly frozen independent validation for semantic tuning, not held-out answers injected into product code. Local mocked tests, real subprocess conversion, live ASR/model quality, actual platform permissions and real phone delivery are different evidence. Follow [TESTING.md](TESTING.md).

## 19. Sources and access limitations

### Reading the bibliography

All external references below were requested during this research on **17 October 2026**. “Reviewed” means readable relevant documentation was inspected directly or through targeted excerpts; it does not imply every page or linked endpoint was tested. References support only their stated scope. The much larger app catalog includes export-first proposals with **no claim of verified app API support**.

Primary docs are preferred for policy/API constraints; maintained tool READMEs describe technical candidates. Neither constitutes legal permission or Pico live verification. Fast-changing policies, access tiers, export formats and product lifecycle status must be checked again before implementation.

### 19.1 Platform and app references

| Reference | Reviewed finding / scope |
| --- | --- |
| [TG-API] | Telegram Bot API message/media types, file handles, local-server capabilities and transfer constraints |
| [TG-FAQ] | Hosted `getFile` maximum of 20 MB; bot behavior/rate-limit distinctions |
| [YT-CAPTIONS] | Caption track resources; list is metadata, download is separate |
| [YT-DOWNLOAD] | OAuth scopes and permission to edit the video for caption download |
| [YT-POLICY] | YouTube API audiovisual storage/download, scraping and component-separation restrictions |
| [YT-OEMBED] | Small public example checked: embed HTML/basic metadata, not a transcript |
| [IG-API] | Professional-account API products and scope, not arbitrary personal-account reading |
| [IG-OEMBED] | Display-only purpose and explicit prohibition on other extraction/persistence/derivation; unsupported account/story cases |
| [IG-BASIC-END] | Basic Display retirement date, 4 December 2024 |
| [FB-OVERVIEW] | Meta oEmbed Read feature/app review; not a universal content-ingestion permission |
| [THREADS] | Current API index: posts, media, replies, search and embeds; individual capability permissions still need review |
| [TIKTOK-EMBED] | oEmbed display markup/metadata and removed-content behavior |
| [TIKTOK-DISPLAY] | Authorized user profile/video metadata and scopes; not a universal transcript API |
| [REDDIT-API] | Endpoint/object documentation, including threads and pagination concepts |
| [REDDIT-TERMS] | Documented access identity, use-case/retention/content-rights restrictions; revised policy text inspected |
| [REDDIT-DEVTERMS] | Developer terms available; use alongside specific data/content terms before integration |
| [X-API] | Current API product overview; no fixed pricing/access assumption |
| [X-PUBLISH] | Small public oEmbed example checked: display HTML and basic post metadata, not full thread/media |
| [BLUESKY-THREAD] | Current canonical `getPostThread` schema: no auth required, bounded hierarchy parameters, blocked/not-found response variants |
| [BLUESKY-POSTS] | Current canonical `getPosts` schema: batch of up to 25 AT-URIs, not automatic thread completeness |
| [BLUESKY-LEXICONS] | AT Protocol repository explains canonical Bluesky schemas moved to `bluesky-social/bsky` |
| [MASTODON] | Status/context APIs and visibility/instance-dependent behavior |
| [LINKEDIN] | Scoped Posts API; marketing/community product constraints |
| [SNAP] | Public Profile API, Stories/Saved Stories/Spotlights/Lenses; not personal private Snap access |
| [TWITCH] | Documented clip/video/stream API resources; not a general media/recording rights grant |
| [SPOTIFY-OEMBED] | Display-oriented Spotify embed metadata interface |
| [SPOTIFY-POLICY] | AI ingestion, analysis, transfer and voice-assistant restrictions; do not reduce this to training-only |
| [APPLE-PODCASTS] | Transcript UX, selected sharing up to 200 words, publisher VTT/SRT and dynamic-audio limitations |
| [PODCAST-RSS] | `<podcast:transcript>` attributes and example formats |
| [SOUNDCLOUD] | oEmbed display interface; not unrestricted audio access |
| [BANDCAMP] | Terms available; individual content/download/AI rights need specific review |
| [SIGNAL] | Backup/transfer/restore documentation; not evidence of generic readable chat export |
| [DISCORD] | Message objects, embeds/attachments, permissions/intents and file-reference considerations |
| [SLACK] | Authenticated replies endpoint/scopes and errors; workspace context required |
| [TEAMS] | Microsoft Graph message retrieval and hosted-content context |
| [LINE] | Messaging API account webhook intake, not personal-chat-history access |
| [GMAIL-GET] | Explicit Gmail message retrieval and formats |
| [GOOGLE-DRIVE] | Native export vs blob download, permissions and product-specific methods |
| [GDRIVE-EXPORT] | Google Workspace export MIME formats; product-specific fidelity |
| [GOOGLE-DOCS] | Structured document resource; complete editorial coverage is not assumed |
| [GOOGLE-SHEETS] | Spreadsheet resource and representation distinctions |
| [CALENDAR-EVENTS] | Event objects, recurrence/time fields; reading an event is not accepting it |
| [GOOGLE-TAKEOUT] | Explicit account-data download/export; selection and privacy matter |
| [MS-DRIVE] | Graph file-content download and authorization context |
| [NOTION] | Block retrieval alone is not a complete page read |
| [NOTION-CHILDREN] | Paginated child blocks and recursive content coverage |
| [NOTION-FILES] | Temporary Notion-hosted file URLs, documented one-hour validity |
| [NEXTCLOUD] | Explicit WebDAV API family; account/share scope remains separate |
| [JOPLIN] | Token-authenticated Data API and note/resource objects |
| [FIGMA] | File/node endpoints; visual rendering and account scopes remain distinct |
| [CANVA] | Design retrieval metadata/API scope; export is separate from metadata |
| [JIRA] | Tenant-scoped REST API overview and authorization requirements |
| [TRELLO] | Card resource APIs, checklist/attachment/comment distinctions |
| [READWISE] | Reader API and selected document operations |
| [RAINDROP] | Raindrop bookmark API family; not rights to every target page |
| [GITHUB] | Repository contents API, revisions and file identity |
| [GITHUB-ISSUES] | Issue API, not identical to PR reviews/discussions |
| [GITHUB-GISTS] | Gist files/revisions; content remains inert |
| [GITLAB] | Repository file retrieval with explicit project/ref identity |
| [STACK] | Questions-by-ID and filters; answer/comment coverage is separate |
| [ZOTERO] | Library/item API, permissions and bibliographic objects |
| [ARXIV] | arXiv API metadata access; versioned full text is separate |
| [CROSSREF] | DOI bibliographic metadata; not blanket full-text rights |
| [PMC] | Developer interfaces and article/access-license distinctions |
| [WIKIPEDIA] | MediaWiki REST overview; original references/revisions still matter |
| [OPENLIBRARY] | Work/edition bibliographic APIs, not universal ebook access |
| [TMDB] | API overview; current license/attribution use needs review |
| [GOOGLE-MAPS] | Maps URLs and place/route link semantics, not a Places reuse license |
| [OSM] | Data access/download and licensing/attribution context |
| [KOMOOT] | Route/activity export/import help; app and format limitations |
| [EVENTBRITE] | Event/ticket API family and scoped access |
| [TICKETMASTER] | Event discovery API; ticket access/redemption is a different capability |
| [SHOPIFY] | Storefront product objects and selected-store access |
| [AMAZON] | Old PA-API documentation redirects to explicit deprecation/migration notice |
| [AMAZON-CREATORS] | Creators API introduction; eligibility and permitted use need separate assessment |
| [ETSY] | Current Open API family, registration/scoped use |
| [STRAVA] | Activity/route API reference; endpoint existence alone does not establish permitted AI use |
| [STRAVA-AGREEMENT] | Current API agreement, athlete-specific disclosure and deletion requirements |
| [STRAVA-POLICY] | API policy sections 3.5/5.3/5.5: ordinary API AI/indexing prohibition and narrow personal-use Strava MCP exception |
| [OPENAI-SHARED-CHAT] | Personal/workspace sharing, snapshot/update behavior, file visibility and shared-task distinctions |
| [CLAUDE-SHARED-CHAT] | Snapshot sharing, organization limits, attached-file/raw-MCP exclusions |
| [EXIF-PRIVACY] | iPhone photo sharing can omit location/metadata; only received bytes are evidence |
| [ANDROID-SHARE] | Explicit shared data/MIME and multiple-item intake concepts |
| [APPLE-SHARE-EXT] | Share extension input model; no arbitrary originating-app access |
| [CHROME-PDF] | Browser print/export as a practical supplied-document path |

### 19.2 Standards and technical candidates

| Reference | Reviewed scope |
| --- | --- |
| [OEMBED] | Embed response model; not an acquisition/transcription entitlement |
| [RSS] | Feed/enclosure structure and summary/full-content distinction |
| [ACTIVITYPUB] | Federated social protocol; **not** Bluesky/AT Protocol |
| [ATPROTO-XRPC] | AT Protocol HTTP API, authentication and privacy considerations |
| [ATPROTO-LEXICON] | AT Protocol API/schema definition mechanism |
| [JSONLD] | Schema.org structured metadata extraction concepts |
| [ROBOTS] | Robots Exclusion Protocol; not access authorization |
| [WEB-SHARE] | Web sharing transfers explicitly supplied payloads |
| [WEBVTT] | Timed-text cues and metadata |
| [ICAL] | iCalendar events, times, recurrence and identifiers |
| [CALDAV] | Calendar access/synchronization protocol; not implicit consent to subscribe/write |
| [VCARD] | Contact object format and fields |
| [CARDDAV] | Address-book access protocol; no automatic sync permission |
| [GEOJSON] | Geometry representation and coordinate conventions |
| [EMAIL] | Internet message structure; MIME/attachments add further format handling |
| [EPUB] | Publication structure, navigation and reading order |
| [WARC] | Web archive structure and versioned captures |
| [IIIF] | Image/presentation interfaces useful for selected archive scans |
| [DICOM] | Medical-image standard family; no generic clinical interpretation claim |
| [GTFS] | Static transit schedule specification; realtime is separate |
| [YTDLP] | Current downloader runtime/dependency/option caveats |
| [YTDLP-EXTRACTORS] | Extractor inventory explicitly does not guarantee every site works |
| [FFMPEG] | Stream selection/transcoding/filtering and format handling |
| [FFPROBE] | Bounded stream/container metadata inspection candidate |
| [OPENAI-STT] | File-transcription formats/size/model-specific outputs; not all implemented in Pico |
| [WHISPER] | Reference speech-recognition implementation |
| [FASTER-WHISPER] | Local inference candidate and hardware/precision trade-offs |
| [WHISPERCPP] | Local C/C++ inference candidate and platform/model options |
| [WHISPERX] | Alignment/diarization candidate with additional models/dependencies |
| [TESSERACT] | Local OCR/language data and quality considerations |
| [PDF] | OCRmyPDF: searchable PDF derivative, not universal text/semantic fidelity |
| [ANYDOC] | Converter capabilities; Pico's installed version/integration defines actual shipped support |
| [DOCLING] | Structured document/layout candidate, not an installed Pico capability |
| [MARKITDOWN] | Document-to-Markdown candidate and optional integrations |
| [TIKA] | Broad format-detection/extraction candidate; additional runtime not justified by breadth alone |
| [TRAFILATURA] | Public text extraction/metadata candidate |
| [READABILITY] | Readability extraction and safe use caveats |
| [PLAYWRIGHT] | Browser runtime candidate; introduces script/account/subrequest authority |
| [EXIFTOOL] | Metadata inspection candidate; metadata is sensitive and not verified truth |
| [CLAMAV] | Scanning defense in depth, not safe-execution certification |
| [ZIP] | Archive API safety caveats; importing archives requires additional bounds |

### 19.3 Important documentation gaps encountered

These gaps are kept explicit rather than filled with plausible but unverified API claims:

- **Reddit help overview:** returned 403. API reference and current data/developer terms were readable; exact app approval/quotas still need current onboarding verification.
- **Bluesky:** older API reference redirected to a shell and tutorial/API-directory requests were empty. Following the official repository README located the **new canonical schemas**, which were then reviewed. Endpoint schemas are documented; actual AppView behavior/permissions and Pico ingestion remain untested.
- **Pinterest:** main API docs returned a shell; an index response did not establish endpoint fields or permissions.
- **Vimeo:** developer page returned a shell; a legacy help link redirected to unrelated player parameters. No Vimeo-specific API guarantee is inferred.
- **Facebook:** old/general oEmbed paths failed or returned a not-found page; the Meta oEmbed Read feature page was readable, not a general extraction license.
- **X:** a historical oEmbed documentation URL redirected to a general overview and another guessed path returned 404. The public sample embed response worked, but that establishes only response shape.
- **WhatsApp:** help response exposed only an export-page title. Device-specific export steps/limits were not validated.
- **Dropbox, Obsidian help, Trakt, Immich API, Instapaper API, Goodreads help, Zoom API:** shells/loading-only responses. No current live connector or export guarantee is claimed from them.
- **Apple Maps and Health authorization docs:** current pages exposed only titles/shells. Archived share-extension and current photo-sharing docs were readable; do not extrapolate a Health/iCloud/Notes server API.
- **Google:** older Gmail/Calendar guide/reference routes returned 404. Readable Gmail `messages.get` and Calendar events references were found and used instead.
- **eBay:** overview returned 403. No new Browse API entitlement or current pricing/access claim is made.
- **Pocket lifecycle help:** a client challenge blocked content; an attempted Mozilla blog path returned 404. Do not propose live Pocket sync without separately verifying current service status.
- **Regional/specialist apps:** not individually end-to-end verified. Their catalog rows are explicit export-first handling recommendations, not API certifications.

**Verification boundary:** no paid inference, ASR quality benchmark, real social-media download, OAuth/app review, owner connector activity, phone share-sheet test, Telegram delivery/playback test, deployment change or runtime restart was performed. This document adds no functionality and enables no service.

[TG-API]: https://core.telegram.org/bots/api
[TG-FAQ]: https://core.telegram.org/bots/faq
[YT-CAPTIONS]: https://developers.google.com/youtube/v3/docs/captions
[YT-DOWNLOAD]: https://developers.google.com/youtube/v3/docs/captions/download
[YT-POLICY]: https://developers.google.com/youtube/terms/developer-policies
[YT-OEMBED]: https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&format=json
[IG-OEMBED]: https://developers.facebook.com/docs/instagram-platform/oembed/
[IG-API]: https://developers.facebook.com/docs/instagram-platform/
[IG-BASIC-END]: https://developers.facebook.com/blog/post/2024/09/04/update-on-instagram-basic-display-api/
[FB-OVERVIEW]: https://developers.facebook.com/docs/features-reference/oembed-read/
[THREADS]: https://developers.facebook.com/docs/threads/
[TIKTOK-EMBED]: https://developers.tiktok.com/doc/embed-videos/
[TIKTOK-DISPLAY]: https://developers.tiktok.com/doc/display-api-overview/
[REDDIT-API]: https://www.reddit.com/dev/api/
[REDDIT-TERMS]: https://redditinc.com/policies/data-api-terms
[REDDIT-DEVTERMS]: https://redditinc.com/policies/developer-terms
[X-API]: https://docs.x.com/x-api/introduction
[X-PUBLISH]: https://publish.twitter.com/oembed?url=https://twitter.com/jack/status/20
[BLUESKY-THREAD]: https://raw.githubusercontent.com/bluesky-social/bsky/main/lexicons/app/bsky/feed/getPostThread.json
[BLUESKY-POSTS]: https://raw.githubusercontent.com/bluesky-social/bsky/main/lexicons/app/bsky/feed/getPosts.json
[BLUESKY-LEXICONS]: https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/README.md
[MASTODON]: https://docs.joinmastodon.org/methods/statuses/
[LINKEDIN]: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
[SNAP]: https://developers.snap.com/api/marketing-api/Public-Profile-API/Introduction
[TWITCH]: https://dev.twitch.tv/docs/api/reference/
[SPOTIFY-OEMBED]: https://developer.spotify.com/documentation/embeds/reference/oembed
[SPOTIFY-POLICY]: https://developer.spotify.com/policy
[APPLE-PODCASTS]: https://podcasters.apple.com/support/5316-transcripts-on-apple-podcasts
[PODCAST-RSS]: https://podcasting2.org/docs/podcast-namespace/tags/transcript
[SOUNDCLOUD]: https://developers.soundcloud.com/docs/oembed
[BANDCAMP]: https://bandcamp.com/terms_of_use
[SIGNAL]: https://support.signal.org/hc/en-us/articles/360007059752-Backup-and-Restore-Messages
[DISCORD]: https://discord.com/developers/docs/resources/message
[SLACK]: https://docs.slack.dev/reference/methods/conversations.replies/
[TEAMS]: https://learn.microsoft.com/en-us/graph/api/chatmessage-get
[LINE]: https://developers.line.biz/en/docs/messaging-api/receiving-messages/
[GMAIL-GET]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get
[GOOGLE-DRIVE]: https://developers.google.com/workspace/drive/api/guides/manage-downloads
[GDRIVE-EXPORT]: https://developers.google.com/workspace/drive/api/guides/ref-export-formats
[GOOGLE-DOCS]: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents
[GOOGLE-SHEETS]: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets
[CALENDAR-EVENTS]: https://developers.google.com/workspace/calendar/api/v3/reference/events
[GOOGLE-TAKEOUT]: https://support.google.com/accounts/answer/3024190
[MS-DRIVE]: https://learn.microsoft.com/en-us/graph/api/driveitem-get-content
[NOTION]: https://developers.notion.com/reference/retrieve-a-block
[NOTION-CHILDREN]: https://developers.notion.com/reference/get-block-children
[NOTION-FILES]: https://developers.notion.com/reference/file-object
[NEXTCLOUD]: https://docs.nextcloud.com/server/latest/developer_manual/client_apis/WebDAV/index.html
[JOPLIN]: https://joplinapp.org/help/api/references/rest_api/
[FIGMA]: https://developers.figma.com/docs/rest-api/file-endpoints/
[CANVA]: https://www.canva.dev/docs/connect/api-reference/designs/get-design/
[JIRA]: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
[TRELLO]: https://developer.atlassian.com/cloud/trello/rest/api-group-cards/
[READWISE]: https://readwise.io/reader_api
[RAINDROP]: https://developer.raindrop.io/v1/raindrops
[GITHUB]: https://docs.github.com/en/rest/repos/contents
[GITHUB-ISSUES]: https://docs.github.com/en/rest/issues/issues
[GITHUB-GISTS]: https://docs.github.com/en/rest/gists/gists
[GITLAB]: https://docs.gitlab.com/api/repository_files/
[STACK]: https://api.stackexchange.com/docs/questions-by-ids
[ZOTERO]: https://www.zotero.org/support/dev/web_api/v3/basics
[ARXIV]: https://info.arxiv.org/help/api/index.html
[CROSSREF]: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
[PMC]: https://pmc.ncbi.nlm.nih.gov/tools/developers/
[WIKIPEDIA]: https://www.mediawiki.org/wiki/API:REST_API
[OPENLIBRARY]: https://openlibrary.org/developers/api
[TMDB]: https://developer.themoviedb.org/docs/getting-started
[GOOGLE-MAPS]: https://developers.google.com/maps/documentation/urls/guide
[OSM]: https://wiki.openstreetmap.org/wiki/Downloading_data
[KOMOOT]: https://support.komoot.com/hc/en-us/articles/360022834132-Export-and-import-GPS-files
[EVENTBRITE]: https://www.eventbrite.com/platform/api
[TICKETMASTER]: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
[SHOPIFY]: https://shopify.dev/docs/api/storefront/latest/objects/Product
[AMAZON]: https://webservices.amazon.com/paapi5/documentation/
[AMAZON-CREATORS]: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction
[ETSY]: https://developers.etsy.com/documentation/
[STRAVA]: https://developers.strava.com/docs/reference/
[STRAVA-AGREEMENT]: https://www.strava.com/legal/api
[STRAVA-POLICY]: https://www.strava.com/legal/api_policy
[OPENAI-SHARED-CHAT]: https://help.openai.com/en/articles/7925741-chatgpt-shared-links-faq
[CLAUDE-SHARED-CHAT]: https://support.claude.com/en/articles/10593882-sharing-and-unsharing-chats
[EXIF-PRIVACY]: https://support.apple.com/guide/iphone/share-photos-and-videos-iphf28f17237/ios
[ANDROID-SHARE]: https://developer.android.com/training/sharing/receive
[APPLE-SHARE-EXT]: https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/Share.html
[CHROME-PDF]: https://support.google.com/chrome/answer/1069693
[OEMBED]: https://oembed.com/
[RSS]: https://www.rssboard.org/rss-specification
[ACTIVITYPUB]: https://www.w3.org/TR/activitypub/
[ATPROTO-XRPC]: https://atproto.com/specs/xrpc
[ATPROTO-LEXICON]: https://atproto.com/specs/lexicon
[JSONLD]: https://schema.org/docs/gs.html
[ROBOTS]: https://www.rfc-editor.org/rfc/rfc9309.html
[WEB-SHARE]: https://www.w3.org/TR/web-share/
[WEBVTT]: https://www.w3.org/TR/webvtt1/
[ICAL]: https://www.rfc-editor.org/rfc/rfc5545
[CALDAV]: https://www.rfc-editor.org/rfc/rfc4791
[VCARD]: https://www.rfc-editor.org/rfc/rfc6350
[CARDDAV]: https://www.rfc-editor.org/rfc/rfc6352
[GEOJSON]: https://www.rfc-editor.org/rfc/rfc7946
[EMAIL]: https://www.rfc-editor.org/rfc/rfc5322
[EPUB]: https://www.w3.org/TR/epub-33/
[WARC]: https://iipc.github.io/warc-specifications/
[IIIF]: https://iiif.io/api/
[DICOM]: https://www.dicomstandard.org/current
[GTFS]: https://gtfs.org/documentation/schedule/reference/
[YTDLP]: https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/README.md
[YTDLP-EXTRACTORS]: https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/supportedsites.md
[FFMPEG]: https://ffmpeg.org/ffmpeg.html
[FFPROBE]: https://ffmpeg.org/ffprobe.html
[OPENAI-STT]: https://developers.openai.com/api/docs/guides/speech-to-text
[WHISPER]: https://raw.githubusercontent.com/openai/whisper/main/README.md
[FASTER-WHISPER]: https://raw.githubusercontent.com/SYSTRAN/faster-whisper/master/README.md
[WHISPERCPP]: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/README.md
[WHISPERX]: https://raw.githubusercontent.com/m-bain/whisperX/main/README.md
[TESSERACT]: https://tesseract-ocr.github.io/tessdoc/
[PDF]: https://ocrmypdf.readthedocs.io/en/latest/introduction.html
[ANYDOC]: https://raw.githubusercontent.com/firecrawl/anydoc/main/README.md
[DOCLING]: https://docling-project.github.io/docling/
[MARKITDOWN]: https://raw.githubusercontent.com/microsoft/markitdown/main/README.md
[TIKA]: https://tika.apache.org/
[TRAFILATURA]: https://trafilatura.readthedocs.io/en/latest/
[READABILITY]: https://raw.githubusercontent.com/mozilla/readability/main/README.md
[PLAYWRIGHT]: https://playwright.dev/docs/browsers
[EXIFTOOL]: https://exiftool.org/
[CLAMAV]: https://docs.clamav.net/
[ZIP]: https://docs.python.org/3/library/zipfile.html
