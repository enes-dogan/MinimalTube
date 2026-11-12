/* MinimalTube player - What can be done with a video, wherever it shows: the entries of every ⋮
 * menu (queue and Downloads rows, feed, playlist and Downloads cards) and the actions behind
 * them: download, delete the file (with Undo), go to its channel, open it on YouTube.
 * Loaded in order by player.html (classic scripts sharing one scope). */

const hiddenDeletes = new Set(); // deleted files, while their Undo bar is up

/**
 * A video's download as the app knows it right now.
 * @param {string|null} videoId
 * @returns {object|null} {status: "ready"} when it's downloaded, the running job
 *   ({id, status: "queued" | "downloading" | "merging" | "waiting", percent}) while it's on its
 *   way, null otherwise.
 */
function videoJob(videoId) {
  if (!videoId || hiddenDeletes.has(videoId)) return null;
  return activeDownloads.get(videoId) || (downloadedIds.has(videoId) ? { status: "ready" } : null);
}

/* ---- Download and delete ---- */

async function downloadVideo(v) {
  const id = itemVideoId(v);
  if (!id) return notify("Can't download this item yet", true, 3000);
  try {
    const data = await requestDownloads([id], [v]);
    if (data.queued) {
      activeDownloads.set(id, { id, status: "queued", percent: 0 }); // shown at once; the server's word follows
      paintQueueStatuses();
    }
    notify(data.queued ? "Download queued" : "Already downloading / downloaded");
  } catch (err) {
    notify(`Couldn't queue download: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}
// Marks a video as not downloaded everywhere it shows (Downloads, queue, playlists, feed);
// the returned function puts it all back.
function hideDownloadedFile(id) {
  const at = library.findIndex((item) => item.id === id),
    entry = at >= 0 ? library[at] : null,
    flagged = [];
  hiddenDeletes.add(id);
  if (entry) setLibrary(library.filter((item) => item.id !== id));
  savedPlaylists.forEach((pl) =>
    (pl.items || []).forEach((item) => {
      if (item.id !== id || !item.downloaded) return;
      flagged.push(item);
      item.downloaded = false;
    }),
  );
  const repaint = () => {
    paintQueueStatuses();
    renderPlaylistCards();
    refreshFeedDownloadedFlags();
  };
  repaint();
  return () => {
    hiddenDeletes.delete(id);
    if (entry && !library.some((item) => item.id === id)) {
      const items = library.slice();
      items.splice(Math.min(at, items.length), 0, entry);
      setLibrary(items);
    }
    flagged.forEach((item) => (item.downloaded = true));
    repaint();
  };
}
/** Deletes a video's file: gone from every list at once, from the disk when its Undo bar goes. */
function deleteFile(id, title) {
  if (!id) return;
  if (id === currentVideoId) {
    const keepIndex = queueIndex;
    stopPlayback();
    queueIndex = keepIndex;
  }
  const restore = hideDownloadedFile(id);
  offerUndo(`“${title || id}” deleted`, {
    undo: restore,
    commit: async () => {
      try {
        await api(`/video/${id}`, { method: "DELETE", keepalive: true });
        hiddenDeletes.delete(id);
      } catch (err) {
        restore();
        notify(`Couldn't delete: ${firstLine(err.message)}`, true, 4000);
      }
      reloadLibrary();
    },
  });
}
function deleteLibraryEntry(entry) {
  deleteFile(entry.id, entry.title);
}

/* ---- Its channel ---- */

// "Go to <channel>" for videos that only carry an id: the server knows the uploader from the
// saved info, or looks it up once.
async function goToChannel(videoId, known) {
  if (known && known.channel_id) return openChannel({ id: known.channel_id, name: known.channel });
  notify("Looking up the channel…", false, 2000);
  try {
    const data = await api(`/channel-of/${encodeURIComponent(videoId)}`);
    if (!data.channel_id) throw new Error("no channel found");
    if (known) {
      known.channel = data.channel;
      known.channel_id = data.channel_id;
    }
    openChannel({ id: data.channel_id, name: data.channel, handle: data.handle });
  } catch (err) {
    notify(`Couldn't find the channel: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}

/* ---- Menu entries (see openMenu in menus.js) ---- */

/** "Download", "Downloading…" or "Delete file", whichever fits the video right now. */
function downloadEntry(v) {
  const id = itemVideoId(v),
    // until the Downloads list has loaded, a card's own flag is all there is
    job = videoJob(id) || (libraryKey === null && v.downloaded ? { status: "ready" } : null);
  if (!job) return { label: "Download", key: "S", icon: ICON_DOWNLOAD, onClick: () => downloadVideo(v) };
  if (job.status === "ready")
    return { label: "Delete file", key: "S", icon: ICON_TRASH, danger: true, onClick: () => deleteFile(id, v.title || v.url) };
  return job.status === "waiting"
    ? { label: "Waiting for connection", key: "S", cls: "busy", icon: ICON_DOWNLOAD, disabled: true }
    : { label: "Downloading", key: "S", dots: true, cls: "busy", icon: ICON_DOWNLOAD, disabled: true };
}
/**
 * "Add next to queue" for a video. While a saved playlist is in the queue it refuses
 * (queueLockedReason) instead of adding the video to that playlist.
 */
function addNextEntry(v) {
  return { label: "Add next to queue", key: "Q", icon: ICON_NEXT, refuse: queueLockedReason, onClick: () => queueVideoNext(v) };
}
function channelEntry(videoId, known) {
  if (!videoId) return null;
  return {
    label: known && known.channel ? `Go to ${known.channel}` : "Go to channel",
    key: "G",
    icon: ICON_CHANNEL,
    onClick: () => goToChannel(videoId, known),
  };
}
function openOnYouTubeEntry(v) {
  return {
    label: "Open on YouTube",
    key: "Y",
    icon: ICON_EXTERNAL,
    // the marker lets it past "Open YouTube videos in MinimalTube" (background/links.js)
    onClick: () => chrome.tabs.create({ url: `${watchUrl(v.id)}&minimaltube=skip` }),
  };
}

// a feed card
function videoMenuEntries(v) {
  return [saveToEntry(videoItem(v), "P"), addNextEntry(v), downloadEntry(v), openOnYouTubeEntry(v)];
}
// a queue row
function queueMenuEntries(item) {
  const id = itemVideoId(item),
    v = { id, title: item.title, url: item.url };
  return [
    saveToEntry(id && v, "P"),
    downloadEntry(v),
    {
      label: queue && queue.playlistId ? "Remove from playlist" : "Remove from queue",
      key: "D",
      icon: ICON_REMOVE,
      onClick: () => removeQueueItem(item),
    },
  ];
}
// a download: its row in the side panel, or (`play` given) its card on the Downloads tab
function libraryMenuEntries(entry, { play } = {}) {
  const v = downloadVideoObj(entry);
  return [
    play && { label: "Play", key: "P", icon: ICON_PLAY, onClick: play },
    saveToEntry(videoItem(v)),
    addNextEntry(v),
    channelEntry(entry.id, entry),
    {
      label: isActiveEntry(entry) ? "Cancel download" : "Delete",
      key: "D",
      icon: ICON_TRASH,
      danger: true,
      onClick: () => deleteLibraryEntry(entry),
    },
  ];
}
