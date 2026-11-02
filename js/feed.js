/* MinimalTube player - Subscriptions and the feed: channels, each channel's remembered videos, the merged feed.
 * Loaded in order by player.html (classic scripts sharing one scope). */

/* ---------- subscriptions ---------- */
// Until the server answers (it may still be starting), the feed uses the subscriptions as last seen.
async function loadSubscriptions() {
  try {
    const res = await fetch(`${serverBase}/subscriptions`);
    if (!res.ok)
      throw new Error(
        res.status === 404
          ? "the running server is outdated - restart server.py"
          : `server returned ${res.status}`,
      );
    const data = await res.json();
    subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    subsLoaded = true;
    feedState.serverError = null;
    chrome.storage.local.set({ feedSubscriptions: subscriptions.map((ch) => ch.id) });
  } catch (err) {
    logQuiet("subscriptions", err);
    feedState.serverError = feedFailure(err);
  }
  renderSubChips();
}

// Clicking a channel's name shows only that channel's videos; clicking it again (or
// another channel) deselects / switches. The x still unsubscribes.
let selectedChannel = null;
// A channel opened from a video's description that isn't subscribed: it gets a temporary
// chip (with a + to subscribe) and its latest uploads are shown like a focused channel.
let tempChannel = null;
let subChipsOpen = false; // the list of subscribed channels is hidden until the button is clicked

function toggleChannelFilter(ch) {
  selectedChannel = selectedChannel === ch.id ? null : ch.id;
  tempChannel = null;
  if (selectedChannel) subChipsOpen = false; // the focused channel stays visible in the row below
  renderSubChips();
  showFeed();
}
function clearChannelFocus() {
  selectedChannel = null;
  tempChannel = null;
  subChipsOpen = true;
  renderSubChips();
  showFeed();
}

function renderSubFocus() {
  subFocus.innerHTML = "";
  const ch =
    selectedChannel &&
    (tempChannel && tempChannel.id === selectedChannel
      ? tempChannel
      : subscriptions.find((channel) => channel.id === selectedChannel));
  subFocus.classList.toggle("show", !!ch);
  if (!ch) return;
  const label = document.createElement("span");
  label.textContent = "Showing only";
  const chip = document.createElement("span");
  chip.className = "subChip selected";
  const name = document.createElement("span");
  name.className = "subChipName";
  name.textContent = ch.name;
  name.title = ch.handle || ch.url || ch.name;
  chip.appendChild(name);
  if (tempChannel && tempChannel.id === ch.id) {
    const add = document.createElement("button");
    add.type = "button";
    add.title = `Subscribe to ${ch.name}`;
    add.textContent = "+";
    add.addEventListener("click", subscribeTempChannel);
    chip.appendChild(add);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.title = "Show all channels again";
  clear.textContent = "×";
  clear.addEventListener("click", clearChannelFocus);
  chip.appendChild(clear);
  subFocus.append(label, chip);
}

/* "Unsubscribe?" confirmation, styled like the "Up next" popup */
const confirmUnsub = byId("confirmUnsub"),
  cuTitle = byId("cuTitle"),
  cuYes = byId("cuYes"),
  cuNo = byId("cuNo");
let cuTimer = null,
  cuTarget = null;
function closeConfirmUnsub() {
  clearTimeout(cuTimer);
  cuTimer = null;
  cuTarget = null;
  confirmUnsub.classList.remove("show", "run");
}
function confirmUnsubscribe(ch) {
  cuTarget = ch;
  cuTitle.textContent = ch.name;
  restartAnimation(confirmUnsub, "show", "run");
  clearTimeout(cuTimer);
  cuTimer = setTimeout(closeConfirmUnsub, 8000); // no answer = keep the subscription
  cuNo.focus();
}
cuYes.addEventListener("click", () => {
  const ch = cuTarget;
  closeConfirmUnsub();
  if (ch) removeSubscription(ch);
});
cuNo.addEventListener("click", closeConfirmUnsub);
addLayer({
  el: confirmUnsub,
  level: 4,
  isOpen: () => confirmUnsub.classList.contains("show"),
  close: closeConfirmUnsub,
});
function openChannel(ch) {
  if (!ch || !ch.id) return;
  selectedChannel = ch.id;
  tempChannel = subscriptions.some((channel) => channel.id === ch.id)
    ? null
    : {
        id: ch.id,
        name: ch.name || ch.handle || ch.id,
        handle: ch.handle || null,
      };
  subChipsOpen = false;
  enterBrowse(true);
  setBrowseTab("subs");
  renderSubChips();
  showFeed();
}
// "Go to <channel>" for videos that only carry an id: the server knows the uploader from the
// saved info, or looks it up once.
async function goToChannel(videoId, known) {
  if (known && known.channel_id)
    return openChannel({ id: known.channel_id, name: known.channel });
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
function channelEntry(videoId, known) {
  if (!videoId) return null;
  return {
    label: known && known.channel ? `Go to ${known.channel}` : "Go to channel",
    key: "G",
    icon: ICON_CHANNEL,
    onClick: () => goToChannel(videoId, known),
  };
}
async function subscribeTempChannel() {
  const ch = tempChannel;
  if (!ch) return;
  try {
    await api("/subscriptions", {
      method: "POST",
      body: { input: `https://www.youtube.com/channel/${ch.id}` },
    });
    notify(`Subscribed to ${ch.name}`);
    await loadSubscriptions(); // the chip turns into a normal one
  } catch (err) {
    notify(`Couldn't subscribe: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}
function renderSubChips() {
  if (
    tempChannel &&
    subscriptions.some((channel) => channel.id === tempChannel.id)
  )
    tempChannel = null;
  if (
    selectedChannel &&
    !subscriptions.some((channel) => channel.id === selectedChannel) &&
    !(tempChannel && tempChannel.id === selectedChannel)
  )
    selectedChannel = null;
  subChips.innerHTML = "";
  subChips.classList.toggle("filtering", !!selectedChannel);
  [...subscriptions]
    .sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    )
    .forEach((ch) => {
      const chip = document.createElement("span");
      const selected = ch.id === selectedChannel;
      chip.className = "subChip" + (selected ? " selected" : "");
      const name = document.createElement("span");
      name.className = "subChipName";
      name.textContent = ch.name;
      chip.setAttribute("role", "button");
      chip.setAttribute("aria-pressed", String(selected));
      name.title =
        (ch.handle || ch.url || ch.name) +
        (selected
          ? " - click to show all channels"
          : " - click to show only this channel");
      name.addEventListener("click", () => toggleChannelFilter(ch));
      chip.appendChild(name);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.title = `Unsubscribe from ${ch.name}`;
      btn.textContent = "×";
      btn.addEventListener("click", () => confirmUnsubscribe(ch));
      chip.appendChild(btn);
      subChips.appendChild(chip);
    });
  const none = !subscriptions.length;
  if (none) subChipsOpen = false;
  subsToggle.disabled = none;
  subsToggle.title = none ? "No subscribed channels yet" : "Show your subscribed channels";
  subChips.classList.toggle("open", subChipsOpen);
  subsToggle.classList.toggle("open", subChipsOpen);
  subsToggle.setAttribute("aria-expanded", String(subChipsOpen));
  subsToggleCount.textContent = subscriptions.length
    ? String(subscriptions.length)
    : "";
  renderSubFocus();
}
subsToggle.addEventListener("click", () => {
  subChipsOpen = !subChipsOpen;
  renderSubChips();
});
async function addSubscription() {
  const input = subAddInput.value.trim();
  if (!input) return subAddInput.focus();
  subAddBtn.disabled = true;
  subAddBtn.textContent = "Adding…";
  try {
    const data = await api("/subscriptions", { method: "POST", body: { input } });
    subAddInput.value = "";
    const ch = data.subscription;
    const name = ch ? ch.name : input;
    notify(
      data.already ? `Already subscribed to ${name}` : `Subscribed to ${name}`,
    );
    await loadSubscriptions();
    if (ch && ch.id) {
      // straight to the channel just added (the Subscriptions feed picks its videos up from there)
      selectedChannel = ch.id;
      tempChannel = null;
      subChipsOpen = false;
      renderSubChips();
      showFeed();
    }
  } catch (err) {
    notify(`Couldn't add channel: ${netMessage(firstLine(err.message))}`, true, 4500);
  } finally {
    subAddBtn.disabled = false;
    subAddBtn.textContent = "Add";
  }
}
async function removeSubscription(ch) {
  try {
    await api(`/subscriptions/${encodeURIComponent(ch.id)}`, { method: "DELETE" });
    subscriptions = subscriptions.filter((channel) => channel.id !== ch.id);
    renderSubChips(); // also drops the filter if this was the selected channel
    notify(`Unsubscribed from ${ch.name}`);
    if (channelFeeds.delete(ch.id)) saveFeedMemorySoon();
    showFeed();
  } catch (err) {
    notify(`Couldn't unsubscribe: ${netMessage(firstLine(err.message))}`, true, 4000);
  }
}
subAddBtn.addEventListener("click", addSubscription);
subAddInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) addSubscription();
});
feedRefresh.addEventListener("click", () => refreshFeed(true));

/* ---------- the feed: newest first, merged across channels, loads more on scroll ----------
 * Every channel remembers its newest videos (FEED_CHANNEL_MAX), saved for the FEED_CHANNELS_KEPT
 * channels fetched most recently. A channel's page shows them straight away; the Subscriptions
 * feed is all subscribed channels' videos, newest first, down to the point every one of them is
 * known to (older ones come from the server as you scroll). Then each channel is asked for its
 * newest videos in the background: new uploads slot in, deleted ones go. Only a channel never
 * seen before shows "Loading". */
const FEED_FETCHES_AT_ONCE = 3,
  FEED_PENDING_MS = 2000, // the server is still looking up some dates / titles: ask again
  FEED_PENDING_TRIES = 10,
  FEED_SAVE_DELAY_MS = 3000;
// channel id -> {items: its newest videos, newest first; until; at}: complete from the fetch at
// `at` (ms) back to the upload time `until` (s; 0 = every video of the channel).
const channelFeeds = new Map();
let rememberedSubIds = [];
const feedMemoryReady = new Promise((resolve) =>
  chrome.storage.local.get(["channelFeeds", "feedSubscriptions"], (stored) => {
    Object.entries(stored.channelFeeds || {})
      .filter(([, feed]) => feed && Array.isArray(feed.items))
      .sort((a, b) => a[1].at - b[1].at)
      .forEach(([id, feed]) => channelFeeds.has(id) || channelFeeds.set(id, feed));
    if (Array.isArray(stored.feedSubscriptions)) rememberedSubIds = stored.feedSubscriptions;
    resolve();
  }),
);
chrome.storage.local.remove(["feedSnapshot", "feedChannels"]); // the memory's earlier format
// Saved a moment after the last change, and right away when the window is hidden or closed.
let feedSaveTimer = 0;
function saveFeedMemory() {
  clearTimeout(feedSaveTimer);
  feedSaveTimer = 0;
  chrome.storage.local.set({ channelFeeds: Object.fromEntries(channelFeeds) });
}
function saveFeedMemorySoon() {
  clearTimeout(feedSaveTimer);
  feedSaveTimer = setTimeout(saveFeedMemory, FEED_SAVE_DELAY_MS);
}
const flushFeedMemory = () => feedSaveTimer && saveFeedMemory();
window.addEventListener("pagehide", flushFeedMemory);
document.addEventListener("visibilitychange", () => document.hidden && flushFeedMemory());
const isSubscribed = (id) =>
  subsLoaded ? subscriptions.some((ch) => ch.id === id) : rememberedSubIds.includes(id);
// Over the limit, the channel fetched longest ago is forgotten (one you aren't subscribed to
// first, so the Subscriptions feed keeps its channels).
function forgetOldestChannels() {
  while (channelFeeds.size > FEED_CHANNELS_KEPT) {
    const ids = [...channelFeeds.keys()].filter((id) => id !== selectedChannel);
    channelFeeds.delete(ids.find((id) => !isSubscribed(id)) || ids[0]);
  }
}

const byNewest = (items) => items.sort((a, b) => b.timestamp - a.timestamp);
const feedViewKey = () => (selectedChannel ? `ch:${selectedChannel}` : "all");
const viewChannelIds = () =>
  selectedChannel
    ? [selectedChannel]
    : subsLoaded
      ? subscriptions.map((ch) => ch.id)
      : rememberedSubIds;
// The view shows its channels' videos down to the point all of them are known to (below it, one
// channel's older videos could be missing): the latest of their `bounds`.
const feedUntil = () => (feedState.bounds.size ? Math.max(...feedState.bounds.values()) : null);
const trimToBounds = (items) => {
  const until = feedUntil();
  return until == null ? items : items.filter((item) => item.timestamp >= until);
};
function viewFromMemory() {
  const bounds = new Map(),
    seen = new Set(),
    items = [];
  viewChannelIds().forEach((id) => {
    const feed = channelFeeds.get(id);
    if (!feed) return;
    bounds.set(id, feed.until);
    feed.items.forEach((item) => seen.has(item.id) || (seen.add(item.id), items.push(item)));
  });
  return { items: byNewest(items), bounds };
}
function showFeed(refresh = true) {
  return feedMemoryReady.then(() => {
    if (subsLoaded && !subscriptions.length && !tempChannel) return showNoSubscriptions();
    const key = feedViewKey(),
      channels = viewChannelIds().join(",");
    if (key !== feedState.key || channels !== feedState.channels || !feedState.loaded) {
      if (key !== feedState.key) browseBody.scrollTop = 0; // another channel starts at the top
      const { items, bounds } = viewFromMemory();
      feedState.epoch++;
      Object.assign(feedState, { key, channels, bounds, loaded: true, loading: false, failed: false });
      feedState.items = trimToBounds(items);
      feedGrid.innerHTML = "";
      hideFeedNewPill();
      renderFeed();
    }
    finishFeedStatus();
    if (refresh) return refreshFeed();
  });
}
function showNoSubscriptions() {
  feedState.epoch++;
  Object.assign(feedState, { key: "none", channels: "", items: [], bounds: new Map(), loaded: true, loading: false });
  feedGrid.innerHTML = "";
  setFeedStatus("No subscriptions yet. Add a channel above, e.g. @youtube or a channel URL.");
}

/* ---- Asking the server: each channel for its newest videos, a few at a time ---- */
const channelFetches = new Map(), // channel id -> its fetch in flight
  channelPending = new Map(), // channel id -> times asked again for lookups still running
  feedErrors = new Map(); // channel id -> name, for channels the server couldn't read
let feedRefreshes = 0,
  feedNetBackAt = 0; // back online: everything fetched before then is asked again
function feedStale(id) {
  const feed = channelFeeds.get(id);
  return !feed || feed.at < feedNetBackAt || Date.now() - feed.at > FEED_BG_REFRESH_MS;
}
async function refreshFeed(force = false) {
  await feedMemoryReady;
  const ids = viewChannelIds().filter((id) => force || feedStale(id));
  if (!ids.length) return finishFeedStatus();
  // the channels most likely to have something new first; never fetched ones before all
  const newest = (id) => {
    const feed = channelFeeds.get(id);
    return !feed ? Infinity : feed.items.length ? feed.items[0].timestamp : 0;
  };
  ids.sort((a, b) => newest(b) - newest(a) || 0);
  feedRefreshes++;
  feedRefresh.classList.add("spinning");
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      if (force || feedStale(id)) await fetchChannel(id, force); // another refresh may have just done it
    }
  };
  const runs = Array.from({ length: Math.min(FEED_FETCHES_AT_ONCE, ids.length) }, worker);
  finishFeedStatus();
  await Promise.all(runs);
  if (!--feedRefreshes) feedRefresh.classList.remove("spinning");
  finishFeedStatus();
}
function fetchChannel(id, force = false) {
  if (!channelFetches.has(id))
    channelFetches.set(id, fetchChannelNow(id, force).finally(() => channelFetches.delete(id)));
  return channelFetches.get(id);
}
function feedFailure(err) {
  return err instanceof TypeError
    ? `Couldn't reach the MinimalTube server at ${serverBase}.`
    : `Couldn't load the feed: ${firstLine(err.message)}`;
}
async function fetchChannelNow(id, force) {
  const params = new URLSearchParams({ offset: "0", limit: String(FEED_CHANNEL_MAX), channel: id });
  if (force) params.set("refresh", "1");
  if (tempChannel && tempChannel.id === id) params.set("name", tempChannel.name);
  let data;
  try {
    data = await api(`/feed?${params}`);
  } catch (err) {
    logQuiet("feed", err);
    feedState.serverError = feedFailure(err);
    return finishFeedStatus();
  }
  feedState.serverError = null;
  const errors = Array.isArray(data.errors) ? data.errors : [];
  if (errors.length) feedErrors.set(id, errors[0].channel);
  else feedErrors.delete(id);
  const tries = data.pending ? (channelPending.get(id) || 0) + 1 : 0;
  if (tries && tries <= FEED_PENDING_TRIES) {
    channelPending.set(id, tries);
    setTimeout(() => fetchChannel(id), FEED_PENDING_MS);
  } else channelPending.delete(id);
  mergeChannel(id, data);
  finishFeedStatus();
}
// A channel's newest videos from the server go into its memory and into the view showing it.
// Remembered ones newer than the oldest of them that the server no longer lists were deleted
// (unless it's offline, or still dating some Shorts, which it leaves out meanwhile).
function mergeChannel(id, data) {
  const fresh = Array.isArray(data.items) ? data.items : [],
    old = channelFeeds.get(id);
  feedState.offline = !!data.offline;
  if ((data.offline && old) || (data.has_more && !fresh.length)) return;
  const cutoff = data.has_more ? fresh[fresh.length - 1].timestamp : 0,
    prune = !data.pending && !data.offline,
    // does this reach back to the previous fetch? If not, what came out in between is unknown
    overlap = !!old && cutoff <= old.at / 1000,
    until = overlap ? Math.min(cutoff, old.until) : cutoff,
    freshIds = new Set(fresh.map((item) => item.id));
  const stays = (item) =>
    !freshIds.has(item.id) && item.timestamp >= until && !(prune && item.timestamp > cutoff);
  const all = byNewest([...fresh, ...(old ? old.items.filter(stays) : [])]),
    items = all.slice(0, FEED_CHANNEL_MAX);
  channelFeeds.delete(id); // re-added last: fetched most recently
  channelFeeds.set(id, {
    items,
    until: all.length > items.length ? items[items.length - 1].timestamp : until,
    at: data.offline ? 0 : Date.now(),
  });
  forgetOldestChannels();
  saveFeedMemorySoon();
  if (!feedState.loaded || !viewChannelIds().includes(id)) return;
  const known = feedState.bounds.get(id);
  feedState.bounds.set(id, overlap && known != null ? Math.min(cutoff, known) : cutoff);
  const gone = (item) => item.channel_id === id && prune && item.timestamp > cutoff;
  feedState.items = trimToBounds(
    byNewest([...fresh, ...feedState.items.filter((item) => !freshIds.has(item.id) && !gone(item))]),
  );
  renderFeed(true);
}

/* ---- Further down: pages of the server's merged order ---- */
function feedParams(offset, limit) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (selectedChannel) params.set("channel", selectedChannel);
  if (tempChannel && tempChannel.id === selectedChannel) params.set("name", tempChannel.name);
  return params;
}
async function loadMoreFeed() {
  if (feedState.loading || feedUntil() === 0 || feedState.failed) return;
  const epoch = feedState.epoch,
    offset = feedState.items.length;
  feedState.loading = true;
  setFeedStatus("Loading more…");
  try {
    const data = await api(`/feed?${feedParams(offset, FEED_LIMIT)}`);
    if (epoch !== feedState.epoch) return;
    addFeedPage(data);
    if (data.pending) setTimeout(() => refetchFeedPage(epoch, offset), FEED_PENDING_MS);
  } catch (err) {
    if (epoch !== feedState.epoch) return;
    feedState.failed = true;
    logQuiet("feed", err);
    return setFeedStatus(`Couldn't load more: ${netMessage(firstLine(err.message))}`, true);
  } finally {
    if (epoch === feedState.epoch) feedState.loading = false;
  }
  finishFeedStatus();
}
// Lookups the server was still running for that page: its Shorts slot in, titles get fixed.
async function refetchFeedPage(epoch, offset, tries = 1) {
  if (epoch !== feedState.epoch) return;
  try {
    const data = await api(`/feed?${feedParams(offset, FEED_LIMIT)}`);
    if (epoch !== feedState.epoch) return;
    addFeedPage(data);
    finishFeedStatus();
    if (data.pending && tries < FEED_PENDING_TRIES)
      setTimeout(() => refetchFeedPage(epoch, offset, tries + 1), FEED_PENDING_MS);
  } catch (err) {
    logQuiet("feed", err);
  }
}
function addFeedPage(data) {
  const page = Array.isArray(data.items) ? data.items : [],
    pageById = new Map(page.map((item) => [item.id, item])),
    known = new Set(feedState.items.map((item) => item.id));
  feedState.items = byNewest([
    ...feedState.items.map((item) => pageById.get(item.id) || item),
    ...page.filter((item) => !known.has(item.id)),
  ]);
  feedState.offline = !!data.offline;
  // the server's order is complete for every channel down to the end of the page
  const end = !data.has_more ? 0 : page.length ? page[page.length - 1].timestamp : null;
  if (!data.offline && end != null)
    viewChannelIds().forEach((id) => feedState.bounds.set(id, Math.min(feedState.bounds.get(id) ?? end, end)));
  renderFeed(true);
}

/* ---- Drawing ---- */
const feedCardText = (item) =>
  [item.title, item.views, item.thumbnail, item.duration, item.channel, timeAgo(item.timestamp)].join("\n");
// Draws feedState.items over the cards already there: those stay (and with them the scroll
// position, keyboard focus and open menus) unless their video changed; new ones fade in when
// `marking`. New uploads (newer than everything shown before) arriving while you're scrolled
// down get the "new videos" pill.
function renderFeed(marking = false) {
  const first = feedGrid.firstElementChild,
    newest = first && first._video ? first._video.timestamp : Infinity,
    keep = new Set(feedState.items.map((item) => item.id)),
    cards = new Map();
  [...feedGrid.children].forEach((card) => {
    if (card._video && keep.has(card._video.id)) cards.set(card._video.id, card);
    else card.remove();
  });
  const top = browseBody.scrollTop;
  let prev = null,
    added = 0;
  feedState.items.forEach((item) => {
    let card = cards.get(item.id);
    if (card && feedCardText(card._video) !== feedCardText(item)) {
      const update = makeVideoCard(item);
      card.replaceWith(update);
      card = update;
    }
    if (!card) {
      card = makeVideoCard(item);
      if (marking) {
        card.classList.add("fresh");
        if (item.timestamp > newest) added++;
      }
    }
    const at = prev ? prev.nextSibling : feedGrid.firstChild;
    if (card !== at) feedGrid.insertBefore(card, at);
    prev = card;
  });
  refreshFeedDownloadedFlags();
  if (added && top > 200) showFeedNewPill(added);
}
function setFeedStatus(text, retry = false) {
  feedStatus.textContent = text || "";
  if (retry) {
    const link = document.createElement("a");
    link.textContent = " Retry";
    link.addEventListener("click", () => {
      feedState.failed = false;
      loadMoreFeed();
    });
    feedStatus.appendChild(link);
  }
}
function feedStatusText() {
  const shown = feedState.items.length,
    ids = viewChannelIds(),
    failed = ids.filter((id) => feedErrors.has(id)).map((id) => feedErrors.get(id)),
    couldnt = failed.length ? `Couldn't load: ${failed.join(", ")}.` : "";
  if (isOffline() || feedState.offline)
    return shown
      ? `${OFFLINE_TEXT}: showing the videos loaded earlier. More will load when you're back online.`
      : `${OFFLINE_TEXT}: these videos will load when you're back online.`;
  if (!shown) {
    if (ids.some((id) => channelFetches.has(id) || channelPending.has(id))) return "Loading latest uploads…";
    if (feedState.serverError) return feedState.serverError;
    if (couldnt) return couldnt;
    if ((!subsLoaded && !selectedChannel) || ids.some((id) => !channelFeeds.has(id)))
      return "Loading latest uploads…";
    return "No videos found."; // every channel here was asked: none has public videos
  }
  if (feedState.serverError) return `${feedState.serverError} Showing the videos loaded earlier.`;
  return `${couldnt} ${feedUntil() === 0 ? "You're all caught up." : ""}`.trim();
}
function finishFeedStatus() {
  if (!feedState.loaded || feedState.key === "none" || feedState.loading || feedState.failed) return;
  setFeedStatus(feedStatusText());
  requestAnimationFrame(maybeLoadMore);
}
// Back online: every channel is asked again (the ones on screen now, the rest when shown).
whenNetChanges((offline) => {
  if (offline) return finishFeedStatus();
  feedNetBackAt = Date.now();
  feedState.failed = false;
  feedState.offline = false;
  if (feedState.loaded && document.body.classList.contains("browsing") && browseTab === "subs")
    refreshFeed();
});
const feedNewPill = document.createElement("button");
feedNewPill.type = "button";
feedNewPill.id = "feedNewPill";
feedNewPill.className = "btn btn-tint";
subsView.prepend(feedNewPill);
let feedNewCount = 0;
function showFeedNewPill(count) {
  feedNewCount += count;
  feedNewPill.textContent = `↑ ${feedNewCount} new video${feedNewCount === 1 ? "" : "s"}`;
  feedNewPill.classList.add("show");
}
function hideFeedNewPill() {
  feedNewCount = 0;
  feedNewPill.classList.remove("show");
}
feedNewPill.addEventListener("click", () => {
  hideFeedNewPill();
  browseBody.scrollTo({ top: 0, behavior: "smooth" });
});
browseBody.addEventListener(
  "scroll",
  () => {
    if (browseBody.scrollTop < 80) hideFeedNewPill();
  },
  { passive: true },
);
function maybeLoadMore() {
  if (!document.body.classList.contains("browsing") || browseTab !== "subs") return;
  if (!feedState.loaded || feedState.key === "none" || !feedState.items.length) return;
  if (feedUntil() === 0 || feedState.loading || feedState.failed || isOffline()) return;
  const left = browseBody.scrollHeight - browseBody.scrollTop - browseBody.clientHeight;
  if (left < 700) loadMoreFeed();
}
browseBody.addEventListener("scroll", maybeLoadMore, {
  passive: true,
});
