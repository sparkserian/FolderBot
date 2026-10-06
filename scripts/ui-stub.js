// A stand-in for the Electron preload bridge, used by scripts/ui-preview.mjs and
// scripts/check-ui.mjs to render the real renderer bundle in a plain browser with realistic data.
// ?scenario=busy|idle|new|broken picks the data; ?route= opens a page.
(function () {
  const params = new URLSearchParams(location.search);
  const scenario = params.get("scenario") || "busy";
  const route = params.get("route") || "activity";
  const now = Date.now();
  const iso = (offsetSeconds) => new Date(now - offsetSeconds * 1000).toISOString();
  const GB = 1024 * 1024 * 1024;

  window.__probe = { statusListenerRegistered: false, errors: [] };
  window.addEventListener("error", (e) => window.__probe.errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => window.__probe.errors.push("rejection: " + e.reason));

  const configured = scenario !== "new";
  const settings = {
    tmdbBearerToken: "", tvdbApiKey: configured ? "key" : "", tvdbPin: "", defaultLanguage: "en-US",
    launchAtLogin: true, automationEnabled: configured,
    automationInboxDirectory: configured ? "D:\\Downloads\\Complete" : "",
    automationSourceLibraryDirectory: configured ? "E:\\Media\\TV" : "",
    automationMirrorLibraryDirectory: configured ? "F:\\Mirror\\TV" : "",
    automationMovieSourceDirectory: configured ? "E:\\Media\\Movies" : "",
    automationMovieMirrorDirectory: configured ? "F:\\Mirror\\Movies" : "",
    automationSourceId: "tvdb", automationSettleSeconds: 45, notifyOnFiled: true, notifyOnFailure: true
  };

  const job = (fields) => ({
    attempts: 0, firstSeenAt: iso(600), stageSince: iso(40), size: 2.1 * GB, ...fields,
    id: "D:\\Downloads\\Complete\\" + fields.fileName, inboxPath: "D:\\Downloads\\Complete\\" + fields.fileName
  });

  const busyJobs = [
    job({
      fileName: "The.Bear.S03E04.2160p.WEB-DL.DDP5.1.H.265.mkv", size: 20.4 * GB, stage: "copying",
      mediaKind: "episode", title: "The Bear", targetName: "The Bear - S03E04 - Violet.mkv", stageSince: iso(95),
      detail: "Copying to the mirror library: F:\\Mirror\\TV\\The Bear\\Season 03",
      progress: { step: "mirror", stepIndex: 1, stepCount: 2, bytesDone: 8.6 * GB, bytesTotal: 20.4 * GB, bytesPerSecond: 112 * 1024 * 1024, etaSeconds: 108 }
    }),
    job({
      fileName: "Severance.S02E07.1080p.mkv", stage: "failed", stageSince: iso(300), attempts: 1,
      detail: "Not enough space for the mirror library: the file needs 2.1 GB and drive F: has 1.4 GB free.",
      error: { message: "Not enough space for the mirror library: the file needs 2.1 GB and drive F: has 1.4 GB free.", hint: "Free up space on that drive, then press Retry.", code: "ENOSPC", at: iso(300) }
    }),
    job({
      fileName: "Shogun.2024.S01E09.mkv", stage: "locked", stageSince: iso(190), size: 3.4 * GB,
      detail: "Another program has this file open (often the downloader or a virus scan). Filing starts as soon as it lets go. (for 3 min)"
    }),
    job({ fileName: "Andor.S02E01.2160p.mkv", stage: "queued", size: 9.8 * GB, stageSince: iso(12), detail: "Ready. Waiting for The.Bear.S03E04.2160p.WEB-DL.DDP5.1.H.265.mkv to finish first." }),
    job({ fileName: "Slow.Horses.S04E02.1080p.mkv", stage: "settling", size: 1.7 * GB, stageSince: iso(20), detail: "No changes for 20s. Starts in 25s if it stays that way." }),
    job({ fileName: "Dune.Part.Two.2024.2160p.BluRay.x265.mkv", stage: "arriving", size: 31.2 * GB, stageSince: iso(400), growthBytesPerSecond: 48 * 1024 * 1024, detail: "Still arriving: 31.2 GB so far, growing about 48 MB/s." }),
    job({ fileName: "home video.mkv", stage: "skipped", size: 0.4 * GB, stageSince: iso(3600), detail: "Skipped by you. FolderBot will leave it alone until the file changes." }),
    job({
      fileName: "The.Bear.S03E03.2160p.WEB-DL.mkv", stage: "filed", mediaKind: "episode", title: "The Bear", size: 19.9 * GB,
      targetName: "The Bear - S03E03 - Doors.mkv", finishedAt: iso(240), detail: "Filed as The Bear - S03E03 - Doors.mkv",
      sourceLibraryPath: "E:\\Media\\TV\\The Bear\\Season 03\\The Bear - S03E03 - Doors.mkv"
    }),
    job({
      fileName: "Past.Lives.2023.1080p.WEBRip.x264.mkv", stage: "filed", mediaKind: "movie", title: "Past Lives", size: 2.3 * GB,
      targetName: "Past Lives (2023) WEBRip x264 1080p.mkv", finishedAt: iso(1900), detail: "Filed",
      sourceLibraryPath: "E:\\Media\\Movies\\Past Lives (2023) WEBRip x264 1080p.mkv"
    })
  ];

  const events = [
    { createdAt: iso(5), message: "Copied 8.6 GB of The.Bear.S03E04…", level: "info" },
    { createdAt: iso(95), message: "Filing The.Bear.S03E04.2160p.WEB-DL.DDP5.1.H.265.mkv (20.4 GB).", level: "info" },
    { createdAt: iso(240), message: "Filed The.Bear.S03E03.2160p.WEB-DL.mkv as The Bear - S03E03 - Doors.mkv.", level: "success" },
    { createdAt: iso(300), message: "Could not file Severance.S02E07.1080p.mkv: Not enough space for the mirror library.", level: "error" }
  ];

  const status = {
    enabled: configured, watching: configured, processing: scenario === "busy",
    inboxDirectory: settings.automationInboxDirectory, sourceLibraryDirectory: settings.automationSourceLibraryDirectory,
    mirrorLibraryDirectory: settings.automationMirrorLibraryDirectory, movieSourceDirectory: settings.automationMovieSourceDirectory,
    movieMirrorDirectory: settings.automationMovieMirrorDirectory, sourceId: "tvdb", settleSeconds: 45,
    pendingCount: scenario === "busy" ? 3 : 0,
    recentEvents: scenario === "busy" ? events : [],
    jobs: scenario === "busy" ? busyJobs : scenario === "idle" ? busyJobs.filter((item) => item.stage === "filed") : [],
    problems: scenario === "busy" ? [{ message: "The Movie mirror library cannot be found.", hint: "F:\\Mirror\\Movies is missing. If it is on an external or network drive, check the drive is connected.", path: "F:\\Mirror\\Movies" }] : [],
    lastScanAt: iso(2), logPath: "C:\\Users\\will\\AppData\\Roaming\\FolderBot\\automation.log"
  };

  const automationHistory = [
    { id: "a1", createdAt: iso(240), sourceId: "tvdb", mediaKind: "episode", originalInboxPath: "D:\\Downloads\\Complete\\The.Bear.S03E03.2160p.WEB-DL.mkv", sourceLibraryPath: "E:\\Media\\TV\\The Bear\\Season 03\\The Bear - S03E03 - Doors.mkv", mirrorLibraryPath: "F:\\Mirror\\TV\\The Bear\\Season 03\\The Bear - S03E03 - Doors.mkv", displayTitle: "The Bear" },
    { id: "a2", createdAt: iso(1900), sourceId: "local", mediaKind: "movie", originalInboxPath: "D:\\Downloads\\Complete\\Past.Lives.2023.1080p.WEBRip.x264.mkv", sourceLibraryPath: "E:\\Media\\Movies\\Past Lives (2023) WEBRip x264 1080p.mkv", mirrorLibraryPath: "F:\\Mirror\\Movies\\Past Lives (2023) WEBRip x264 1080p.mkv", displayTitle: "Past Lives" },
    { id: "a3", createdAt: iso(90000), sourceId: "tvdb", mediaKind: "episode", originalInboxPath: "D:\\Downloads\\Complete\\Shogun.S01E08.mkv", sourceLibraryPath: "E:\\Media\\TV\\Shogun\\Season 01\\Shogun - S01E08 - The Abyss of Life.mkv", mirrorLibraryPath: "F:\\Mirror\\TV\\Shogun\\Season 01\\Shogun - S01E08 - The Abyss of Life.mkv", displayTitle: "Shogun", undoneAt: iso(80000) }
  ];
  const renameHistory = [
    { id: "m1", createdAt: iso(5000), sourceId: "tvdb", itemCount: 3, items: [
      { id: "i1", sourcePath: "C:\\Rips\\fargo s1e1.mkv", targetPath: "C:\\Rips\\Fargo - S01E01 - The Crocodile's Dilemma.mkv" },
      { id: "i2", sourcePath: "C:\\Rips\\fargo s1e2.mkv", targetPath: "C:\\Rips\\Fargo - S01E02 - The Rooster Prince.mkv" },
      { id: "i3", sourcePath: "C:\\Rips\\fargo s1e3.mkv", targetPath: "C:\\Rips\\Fargo - S01E03 - A Muddy Road.mkv" }
    ] }
  ];

  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 5));
  let navigateListener = null;

  window.folderBot = {
    platform: params.get("platform") || "win32",
    pickFiles: () => later(["C:\\Rips\\severance.s02e01.1080p.web.mkv", "C:\\Rips\\severance.s02e02.1080p.web.mkv", "C:\\Rips\\Severance S02E03 720p.mkv", "C:\\Rips\\family trip.mkv"]), pickOutputDirectory: () => later(null), pickOutputDirectories: () => later([]),
    getPathForFile: () => null,
    getSettings: () => later(settings), saveSettings: (patch) => later(Object.assign(settings, patch)),
    getAutomationStatus: () => later(status),
    setAutomationEnabled: (enabled) => later(Object.assign(settings, { automationEnabled: enabled })),
    retryAutomationJob: () => later(), skipAutomationJob: () => later(), clearFinishedAutomationJobs: () => later(),
    repairSeasonPlacement: () => later([]), searchAutomationSeries: () => later([]), repairAutomationHistoryEntries: () => later({ updatedCount: 0, results: [] }),
    getAutomationHistory: () => scenario === "broken" ? Promise.reject(new Error("Unexpected end of JSON input")) : later(scenario === "new" ? [] : automationHistory),
    undoAutomationHistoryEntry: () => later({ entryId: "", results: [] }),
    getRenameHistory: () => later(scenario === "new" ? [] : renameHistory),
    undoRenameHistoryEntry: () => later({ entryId: "", results: [] }),
    getProviderStatuses: () => later([{ id: "local", label: "Local", ready: true, details: "" }, { id: "tmdb", label: "TMDb", ready: false, details: "" }, { id: "tvdb", label: "TheTVDB", ready: configured, details: "" }]),
    previewRenames: (request) => later(request.filePaths.map((filePath, index) => {
      const name = filePath.split("\\").pop();
      const titles = ["Hello, Ms. Cobel", "Goodbye, Mrs. Selvig", "Who Is Alive?"];
      const known = index < 3;
      return {
        id: filePath, sourcePath: filePath, currentName: name, currentDirectory: "C:\\Rips",
        parsed: known ? { kind: "episode", originalTitle: "severance", normalizedTitle: "severance", season: 2, episode: index + 1, confidence: 0.9, warnings: [] } : { kind: "unknown", originalTitle: name, normalizedTitle: "family trip", confidence: 0.1, warnings: [] },
        metadata: known ? { sourceId: "local", displayTitle: "Severance", season: 2, episode: index + 1 } : null,
        targetName: known ? `Severance - S02E0${index + 1}${request.options.sourceId === "local" ? "" : " - " + titles[index]}.mkv` : name,
        targetPath: "C:\\Rips\\x.mkv", warnings: [],
        conflicts: known ? [] : ["FolderBot could not find a season and episode in this name."]
      };
    })), applyRenames: () => later([]),
    showItemInFolder: () => later(), openFolder: () => later(""), openLog: () => later(""), openExternal: () => later(),
    getAppInfo: () => later({ version: "2.0.0", platform: "win32", userDataPath: "C:\\Users\\will\\AppData\\Roaming\\FolderBot", logPath: status.logPath, packaged: true, accentColor: params.get("accent") || "#0067c0" }),
    getUpdateState: () => later(params.get("update") === "ready" ? { kind: "ready", version: "2.0.1" } : { kind: "idle", checkedAt: iso(1200) }),
    checkForUpdates: () => later({ kind: "idle", checkedAt: new Date().toISOString() }), installUpdate: () => later(),
    onAutomationStatus: (fn) => { window.__probe.statusListenerRegistered = true; window.__pushStatus = fn; return () => {}; },
    onUpdateState: () => () => {}, onSettingsChanged: () => () => {}, onAccentColor: () => () => {},
    onNavigate: (fn) => { navigateListener = fn; setTimeout(() => fn(route), 50); return () => {}; }
  };
})();
