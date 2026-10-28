'use strict';

// Where songs sent from a phone (song sync) are filed: the folder chosen in
// Settings › Connections when it still exists inside one of the library's
// music folders (so the library picks them up), else the first music folder.

function phoneSongFolder({ chosen = '', folders = [], exists = () => true, inside = () => false } = {}) {
  const library = folders.filter(f => f && exists(f));
  if (chosen && exists(chosen) && library.some(f => inside(chosen, f))) return chosen;
  return library[0] || '';
}

// Why a picked folder can't be used, or '' when it can.
function phoneSongFolderProblem(chosen, folders, inside) {
  if (!chosen) return 'No folder chosen.';
  if (!folders.some(f => f && inside(chosen, f))) return 'Choose a folder inside one of your music folders (Settings › Library), so Hive finds the songs.';
  return '';
}

module.exports = { phoneSongFolder, phoneSongFolderProblem };
