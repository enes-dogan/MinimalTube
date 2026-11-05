"""MinimalTube local server.

config    paths, limits and the regexes shared by everything else
ytinfo    the one place that runs yt-dlp: full and light lookups of a video
ytdlp_copy MinimalTube's own yt-dlp (pip, in the data folder) and its updates
net       the connection state (can YouTube be reached?)
store     the JSON files in the cache dir: titles, order, playlists
media     one video's files: mp4, thumbnail, description, chapters, meta
sublang   the caption rule (pure functions over yt-dlp info)
subtitles fetching the chosen captions and re-checking older downloads
downloads the job table, the yt-dlp worker threads and the library listing
feed      subscriptions and the merged "latest uploads" feed
live      streaming a video while it downloads: format list, segment index, byte proxy
routes    the Flask app and every HTTP endpoint
"""
