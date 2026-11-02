"""MinimalTube - which caption track to use. Pure functions over yt-dlp's info dict, so the
rule lives in one place:

    Turkish video  -> Turkish (uploader's) > Turkish (auto) > English (uploader's)
    English video  -> English (uploader's) > English (auto)
    anything else  -> no captions

Auto-generated means YouTube's speech recognition, never a machine translation.
"""

TURKISH_LETTERS = set("ğĞıİşŞ")


def lang_base(code):
    code = str(code or "").strip().lower().replace("_", "-")
    if not code or code in ("und", "zxx", "mul", "live_chat"):
        return None
    return code.split("-")[0]


def is_native_track(formats) -> bool:
    return any("tlang=" not in str(f.get("url", ""))
               for f in (formats or []) if isinstance(f, dict))


def original_language(info):
    """Auto-dubbed videos carry a '<lang>-orig' caption track for every dub, so those only
    count when there is exactly one; the audio track marked original is the real signal."""
    for f in info.get("formats") or []:
        if (isinstance(f, dict) and f.get("acodec") not in (None, "none")
                and "original" in str(f.get("format_note") or "").lower()
                and lang_base(f.get("language"))):
            return lang_base(f.get("language"))
    lang = lang_base(info.get("language"))
    if lang:
        return lang
    auto = info.get("automatic_captions") or {}
    origs = {lang_base(str(k)[:-5]) for k, v in auto.items()
             if v and str(k).lower().endswith("-orig")} - {None}
    if len(origs) == 1:
        return next(iter(origs))
    if TURKISH_LETTERS & set(str(info.get("title") or "")):
        return "tr"
    return None


def track_key(tracks: dict, lang: str, is_auto: bool):
    keys = [k for k, v in (tracks or {}).items() if k != "live_chat" and v]
    lower = {k.lower(): k for k in keys}
    ordered = [lower[k] for k in ([f"{lang}-orig", lang] if is_auto else [lang]) if k in lower]
    ordered += sorted((k for k in keys if k.lower().startswith(f"{lang}-") and k not in ordered),
                      key=lambda k: (k.lower() not in ("en-us", "en-gb"), k))
    for k in ordered:
        if not is_auto or is_native_track(tracks[k]):
            return k
    return None


def choose_subtitle_track(info):
    """-> (track key, is_auto) or (None, None)."""
    lang = original_language(info)
    if lang == "tr":
        plan = [("tr", False), ("tr", True), ("en", False)]
    elif lang == "en":
        plan = [("en", False), ("en", True)]
    else:
        return None, None
    for want, is_auto in plan:
        tracks = info.get("automatic_captions" if is_auto else "subtitles") or {}
        key = track_key(tracks, want, is_auto)
        if key:
            return key, is_auto
    return None, None
