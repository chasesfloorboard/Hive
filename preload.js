const { contextBridge, ipcRenderer } = require('electron');

try { ipcRenderer.send('startup:preloadEntry'); } catch {}

contextBridge.exposeInMainWorld('beehive', {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  startupDebugEnabled: process.argv.includes('--startup-debug') || process.env.BEEHIVE_STARTUP_DEBUG === '1',
  startupDebugLog: (label, details) => ipcRenderer.invoke('startup:debugLog', { label, details }),
  startupDebugState: () => ipcRenderer.invoke('startup:debugState'),
  getPlaybackState: () => ipcRenderer.invoke('playback-state:get'),
  savePlaybackStateSync: (state) => ipcRenderer.sendSync('playback-state:saveSync', state),
  updatePlaybackTransportSync: (state) => ipcRenderer.sendSync('playback-state:updateTransportSync', state),
  getConfig: () => ipcRenderer.invoke('config:get'),
  discordGetSettings: () => ipcRenderer.invoke('discord:getSettings'),
  discordGetStatus: () => ipcRenderer.invoke('discord:getStatus'),
  discordSaveSettings: (patch) => ipcRenderer.invoke('discord:saveSettings', patch || {}),
  discordUpdateActivity: (payload) => ipcRenderer.invoke('discord:updateActivity', payload || {}),
  discordClearActivity: () => ipcRenderer.invoke('discord:clearActivity'),
  mprisUpdate: (payload) => ipcRenderer.invoke('mpris:update', payload || {}),
  onMprisCommand: (cb) => { const listener = (_evt, command) => cb(command); ipcRenderer.on('mpris:command', listener); return () => ipcRenderer.removeListener('mpris:command', listener); },
  getGpuAcceleration: () => ipcRenderer.invoke('graphics:getGpuAcceleration'),
  setGpuAcceleration: (enabled) => ipcRenderer.invoke('graphics:setGpuAcceleration', !!enabled),
  addFolder: () => ipcRenderer.invoke('config:addFolder'),
  removeFolder: (folder) => ipcRenderer.invoke('config:removeFolder', folder),
  showFileInBrowser: (filePath) => ipcRenderer.invoke('file:showInBrowser', filePath),
  deleteTracksFromDisk: (filePaths) => ipcRenderer.invoke('tracks:deleteFromDisk', filePaths),
  startNativeFileDrag: (filePaths) => ipcRenderer.send('files:startDrag', Array.isArray(filePaths) ? filePaths : [filePaths]),

  getCachedLibrary: () => ipcRenderer.invoke('library:getCached'),
  getLibraryCacheResetSetting: () => ipcRenderer.invoke('library:getCacheResetSetting'),
  setLibraryCacheResetSetting: (enabled) => ipcRenderer.invoke('library:setCacheResetSetting', !!enabled),
  clearLibraryCacheNow: () => ipcRenderer.invoke('library:clearCacheNow'),
  scanLibrary: (options) => ipcRenderer.invoke('library:scan', options),
  scanChangedLibrary: (paths) => ipcRenderer.invoke('library:scanChanged', paths),
  searchLibraryDatabase: (text, limit) => ipcRenderer.invoke('library:searchDatabase', { text, limit }),
  getTaskStatus: () => ipcRenderer.invoke('library:taskStatus'),
  betaSecurityAudit: () => ipcRenderer.invoke('beta:securityAudit'),
  betaLibraryHealth: () => ipcRenderer.invoke('beta:libraryHealth'),
  betaEnvironmentAudit: () => ipcRenderer.invoke('beta:environmentAudit'),
  betaDatabaseHealth: () => ipcRenderer.invoke('beta:databaseHealth'),
  getArtworkProviders: () => ipcRenderer.invoke('artwork:providers'),
  refreshLovedLibrary: () => ipcRenderer.invoke('library:refreshLoved'),
  needsLovedRefresh: () => ipcRenderer.invoke('library:needsLovedRefresh'),
  onScanProgress: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('library:scanProgress', listener);
    return () => ipcRenderer.removeListener('library:scanProgress', listener);
  },
  onScanTrack: (cb) => {
    const listener = (_evt, track) => cb(track);
    ipcRenderer.on('library:scanTrack', listener);
    return () => ipcRenderer.removeListener('library:scanTrack', listener);
  },
  onTagProgress: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('library:tagProgress', listener);
    return () => ipcRenderer.removeListener('library:tagProgress', listener);
  },
  queueMetadataSave: (jobs) => ipcRenderer.send('metadata:saveBatch', Array.isArray(jobs) ? jobs : []),
  onLibraryFilesChanged: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on('library:filesChanged', listener);
    return () => ipcRenderer.removeListener('library:filesChanged', listener);
  },

  toggleLove: (trackPath, value) => ipcRenderer.invoke('track:toggleLove', trackPath, value),
  setLove: (trackPaths, loved) => ipcRenderer.invoke('tracks:setLove', trackPaths, loved),
  readLove: (trackPath) => ipcRenderer.invoke('track:readLove', trackPath),
  readLoves: (paths) => ipcRenderer.invoke('tracks:readLove', paths),
  recordPlay: (trackPath, meta) => ipcRenderer.invoke('track:recordPlay', trackPath, meta),
  clearPlayCounts: () => ipcRenderer.invoke('stats:clearPlayCounts'),
  setEmbedPlayCounts: (enabled) => ipcRenderer.invoke('stats:setEmbedPlayCounts', !!enabled),
  getEmbedPlayCounts: () => ipcRenderer.invoke('stats:getEmbedPlayCounts'),
  embedCurrentPlayCounts: () => ipcRenderer.invoke('stats:embedCurrentPlayCounts'),
  importEmbeddedPlayCounts: () => ipcRenderer.invoke('stats:importEmbeddedPlayCounts'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  setRating: (trackPath, rating) => ipcRenderer.invoke('track:setRating', trackPath, rating),
  setRatings: (trackPaths, rating) => ipcRenderer.invoke('tracks:setRatings', trackPaths, rating),
  readRatings: (paths) => ipcRenderer.invoke('tracks:readRatings', paths),
  updateCachedLoves: (loves) => ipcRenderer.invoke('tracks:updateCachedLoves', loves),
  updateCachedRatings: (ratings) => ipcRenderer.invoke('tracks:updateCachedRatings', ratings),
  embedRatings: (tracks) => ipcRenderer.invoke('tracks:embedRatings', tracks),
  readTags: (trackPath) => ipcRenderer.invoke('track:readTags', trackPath),
  hasEmbeddedArtwork: (trackPath) => ipcRenderer.invoke('track:hasEmbeddedArtwork', trackPath),
  searchLyrics: (query) => ipcRenderer.invoke('lyrics:search', query),
  writeTags: (trackPath, tags) => ipcRenderer.invoke('track:writeTags', trackPath, tags),
  chooseCover: () => ipcRenderer.invoke('cover:choose'),
  writeArtwork: (trackPath, imagePath, artworkMeta) => ipcRenderer.invoke('track:writeArtwork', trackPath, imagePath, artworkMeta),
  modifyArtwork: (trackPath, operation, options = {}) => ipcRenderer.invoke('track:modifyArtwork', trackPath, operation, options),
  metadataBulkWriteStart: (label) => ipcRenderer.invoke('metadata:bulkWriteStart', label),
  metadataBulkWriteEnd: (label) => ipcRenderer.invoke('metadata:bulkWriteEnd', label),
  removeArtwork: (trackPath) => ipcRenderer.invoke('track:removeArtwork', trackPath),
  searchItunes: (query) => ipcRenderer.invoke('cover:searchItunes', query),
  searchInternetCover: (query) => ipcRenderer.invoke('cover:searchInternet', query),
  loadTemporaryCover: (url) => ipcRenderer.invoke('cover:loadTemporary', url),
  downloadSearchCover: (url) => ipcRenderer.invoke('cover:downloadSearchResult', url),
  downloadItunesCover: (url) => ipcRenderer.invoke('cover:downloadItunes', url),
  pasteCover: () => ipcRenderer.invoke('cover:paste'),
  saveImageFile: (imagePath) => ipcRenderer.invoke('cover:saveImage', imagePath),
  saveDataUrlImage: (dataUrl, filename) => ipcRenderer.invoke('cover:saveDataUrlImage', dataUrl, filename),
  copyCover: (coverFile) => ipcRenderer.invoke('cover:copy', coverFile),
  saveCover: (coverFile) => ipcRenderer.invoke('cover:save', coverFile),
  getPlaylists: () => ipcRenderer.invoke('playlists:get'),
  savePlaylist: (playlist) => ipcRenderer.invoke('playlists:save', playlist),
  deletePlaylist: (id) => ipcRenderer.invoke('playlists:delete', id),
  choosePlaylistImportFile: () => ipcRenderer.invoke('playlists:chooseImportFile'),
  exportPlaylistM3U: (payload) => ipcRenderer.invoke('playlists:exportM3U', payload),
  importSpotifyPlaylist: (input) => ipcRenderer.invoke('playlists:importSpotify', input),
  musicBrainzSearchReleaseGroups: (query) => ipcRenderer.invoke('musicbrainz:searchReleaseGroups', query),
  musicBrainzIdentify: (query) => ipcRenderer.invoke('musicbrainz:identify', query),

  gstreamerStatus: () => ipcRenderer.invoke('gstreamer:status'),
  gstreamerCommand: (command) => ipcRenderer.send('gstreamer:command', command),
  onGstreamerEvent: (cb) => { const listener = (_evt, payload) => cb(payload); ipcRenderer.on('gstreamer:event', listener); return () => ipcRenderer.removeListener('gstreamer:event', listener); },

  fileUrl: (absPath) => `mbfile://${encodeURIComponent(absPath)}`,
  coverUrl: (coverFile) => (coverFile ? `mbcover://${encodeURIComponent(coverFile)}` : null)
});
