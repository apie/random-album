/*
 * Copyright (C) 2009 Marcelo Vanzin (vanza@users.sourceforge.net)
 * Copyright (C) 2010 Ghislain Mary
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA
 */

/*
 * Random Album
 *
 * An amarok script that monitors the playlist, and, when it's finished,
 * repopulates it with a random album from the collection. Differently
 * from amarok's built-in "random album" mode, you don't need to keep
 * the whole collection in the playlist; so when you add new stuff to
 * the collection the script will automatically pick it up, and it's
 * easy to manually enqueue songs into the current playlist without
 * the "random mode" triggering whenever the current album finishes
 * playing.
 *
 * What it does: whenever the last track in the current playlist
 * finishes playing, the playlist is cleared and a random album from
 * the collection is chosen to populate the new playlist. The script
 * ignores the last 10 albums played when enqueueing a new album, but
 * other than that provides no bias (e.g., "ignore other albums by same
 * artist as last album" and things like that).
 *
 * It also provides two actions (accessible through shortcuts on the
 * "Tools" menu) to replace the current playlist, or to enqueue a
 * random album to the current playlist.
 *
 * When using this script, it is recommended to disable any repeat or
 * random settings in the "Playlist" menu.
 *
 * This script is inspired and very loosely based on the randomalbum.py
 * script for amarok 1.4, available at the following URL:
 *
 *		http://www.kde-apps.org/content/show.php?content=42764
 *
 * Note: I'm not sure whether Amarok 2 officially supports custom database
 * backends, but this script only supports MySQL (due to the use of MySQL
 * functions in the SQL queries).
 */

Importer.loadQtBinding("qt.core");
Importer.loadQtBinding("qt.gui");
Importer.loadQtBinding("qt.uitools");

//{{{ SQL Queries

var RANDOM_ALBUM_ID =
	"SELECT "
  + "	album "
  + "FROM "
  + "	randomalbum_album_urls "
  + "WHERE "
  + "	url LIKE '%{0}%' "
  + "	AND genre IN ({1}) "

  + "UNION "

  +	"SELECT "
  + "	album "
  + "FROM "
  + "	randomalbum_album_urls_ex "
  + "WHERE "
  + "	url LIKE '%{0}%' "
  + "	AND genre IN ({1}) "

  + "ORDER BY RAND() LIMIT 1";

var ALBUM_TRACKS =
	"SELECT "
  + "    url, "
  + "    discno, "
  + "    trackno "
  + "FROM "
  + "	randomalbum_album_urls "
  + "WHERE "
  + "	album = {0} "
  + "	AND url LIKE '%{1}%' "

  + "UNION "

  + "SELECT "
  + "    url, "
  + "    discno, "
  + "    trackno "
  + "FROM "
  + "	randomalbum_album_urls_ex "
  + "WHERE "
  + "	album = {0} "
  + "	AND url LIKE '%{1}%' "

  + "ORDER BY discno, trackno";

var ALBUM_ARTIST_TRACKS =
	"SELECT "
  + "    url, "
  + "    discno, "
  + "    trackno "
  + "FROM "
  + "	randomalbum_album_urls "
  + "WHERE "
  + "	album = {0} "
  + "   AND artist = {1} "

  + "UNION "

  + "SELECT "
  + "    url, "
  + "    discno, "
  + "    trackno "
  + "FROM "
  + "	randomalbum_album_urls "
  + "WHERE "
  + "	album = {0} "
  + "   AND artist = {1} "

  + "ORDER BY discno, trackno";

/*
 * These two views keep album data in an easy-to-query format for the script;
 * this way it's easy to get the track URLs and to filter by it if necessary.
 * Creating a single view using UNION seems to result in slower queries than
 * creating two views and creating a UNION of the results in the other queries,
 * although it requires more code...
 */

var ALBUM_VIEW_1 =
	"CREATE OR REPLACE VIEW "
  + "	randomalbum_album_urls "
  + "AS "
  + "SELECT "
  + "	tracks.album as album "
  + "	, albums.artist as artist "
  + "   , CONCAT('file://', devices.lastmountpoint, SUBSTR(urls.rpath, 2)) as url "
  + "   , tracks.discnumber as discno "
  + "	, tracks.tracknumber as trackno "
  + "	, tracks.genre as genre "
  + "FROM "
  + "   albums, tracks, urls, devices "
  + "WHERE "
  + "	tracks.album = albums.id "
  + "   AND tracks.url = urls.id "
  + "   AND devices.id = urls.deviceid ";

var ALBUM_VIEW_2 =
	"CREATE OR REPLACE VIEW "
  + "	randomalbum_album_urls_ex "
  + "AS "
  + "SELECT "
  + "	tracks.album as album "
  + "	, albums.artist as artist "
  + "   , CONCAT('file://', SUBSTR(urls.rpath, 2)) as url "
  + "   , tracks.discnumber as discno "
  + "   , tracks.tracknumber as trackno "
  + "   , tracks.genre as genre "
  + "FROM "
  + "   albums, tracks, urls "
  + "WHERE "
  + "	tracks.album = albums.id "
  + "   AND tracks.url = urls.id "
  + "   AND urls.deviceid = -1";

var ALBUM_ARTIST_COUNT =
	"SELECT DISTINCT "
  + "	artist "
  + "FROM "
  + "	albums "
  + "WHERE "
  + "	id = {0}";

var GENRES =
	"SELECT "
  + "	id, name "
  + "FROM "
  + "	genres "
  + "ORDER BY name";

var GENRE_IDS =
	"SELECT "
  + "	id "
  + "FROM "
  + "	genres ";

/*
 * Format function to keep my sanity instead of using string
 * concatenation.
 */
String.prototype.format = function()
{
	var pattern = /\{\d+\}/g;
	var args = arguments;
	return this.replace(pattern,
						function(capture)
						{
							return args[capture.match(/\d+/)];
						});
}

// }}}

var enableRandom = (Amarok.Script.readConfig("enable", "true") == "true");
var pathFilter = Amarok.Script.readConfig("pathFilter", "");

/* Load the saves list of last played albums. */
var lastPlayed = Amarok.Script.readConfig("lastPlayed", "");
if (lastPlayed) {
	lastPlayed = lastPlayed.split(",");
} else {
	lastPlayed = new Array();
}

/* Load the genres from which to choose random albums. */
var genresFilter = Amarok.Script.readConfig("genresFilter", "");
if (genresFilter) {
	genresFilter = genresFilter.split(",");
} else {
	genresFilter = new Array();
}


function getAlbum(aid)
{
	var artists = Amarok.Collection.query(ALBUM_ARTIST_COUNT.format(aid));
	var ulist;
	var tlist;

	/*
	 * In amarok 1.4, if two artists had an album with the same name,
	 * they'd share the same entry in the albums table. This seems to
	 * have changed in 2.0, but the code below tries to protect against
	 * that "just in case" (tm).
	 */

	if (artists.length == 1) {
		ulist = Amarok.Collection.query(ALBUM_TRACKS.format(aid, pathFilter));
	} else {
		var artist = Math.floor(Math.random() * (artists.length - 1));
		artist = parseInt();
		ulist = Amarok.Collection.query(ALBUM_ARTIST_TRACKS.format(aid, artist));
	}
	Amarok.debug("New random album, {0} tracks.".format(ulist.length));

	tlist = new Array();
	for (var i = 0; i < ulist.length; i+= 3) {
		tlist.push(ulist[i]);
	}
	return tlist;
}


function shouldPlayAlbum(idx)
{
	for (var i = 0; i < lastPlayed.length; i++) {
		if (lastPlayed[i] == idx) {
			return false;
		}
	}

	if (lastPlayed.length == 10) {
		lastPlayed.shift();
	}
	lastPlayed.push(idx);
	Amarok.Script.writeConfig("lastPlayed", lastPlayed.join(","));
	return true;
}


function randomize()
{
	/* Get a random album index that hasn't been played recently. */
	var idx;
	var tries = 10;
	var genresStr = genresFilter.length ? genresFilter.join(", ")
										: GENRE_IDS;

	do {
		idx = Amarok.Collection.query(RANDOM_ALBUM_ID.format(pathFilter,
															 genresStr))[0];
		tries--;
	} while (!shouldPlayAlbum(idx) && tries > 0);

	/* Load the album. */
	Amarok.debug("Loading album " + idx);
	var list = getAlbum(idx);
	for (var i = 0; i < list.length; i++) {
		Amarok.debug("Loading track " + list[i]);
		Amarok.Playlist.addMedia(new QUrl(list[i]));
	}
}


function loadRandom()
{
	Amarok.Playlist.clearPlaylist();
	randomize();
}


function startPlaying()
{
	Amarok.Playlist.playByIndex(0);
}


function playRandom()
{
	loadRandom();

	var timer = new QTimer(Amarok.Window);
	timer.singleShot = true;
	timer.timeout.connect(startPlaying);
	timer.start(100);
}


/**
 * If the track that just finished is the last in the playlist,
 * schedule a callback to load a random album as soon as amarok
 * really stops playing the current track.
 */
function trackFinished()
{
	if (enableRandom) {
		var active = Amarok.Playlist.activeIndex();
		if (active == -1 || active == Amarok.Playlist.totalTrackCount() - 1) {
			var stopAfter = false;
			var timer;

			try {
				stopAfter = Amarok.Playlist.stopAfterCurrent();
			} catch (err) {
				/* Just ignore. We're probably running on pre-2.3.1. */
			}

			timer = new QTimer(Amarok.Window);
			timer.singleShot = true;
			if (stopAfter) {
				Amarok.Playlist.setStopAfterCurrent(false);
				timer.timeout.connect(loadRandom);
			} else {
				timer.timeout.connect(playRandom);
			}
			timer.start(100);
		}
	}
}


/**
 * Shows the dialog for configuring random album settings.
 */
function showConfigDialog()
{
	var loader = new QUiLoader(Amarok.Window);
	var file = new QFile(Amarok.Info.scriptPath() + "/rasettings.ui", loader);

	var genres = Amarok.Collection.query(GENRES);
	var genreIds = new Array();
	var genreNames = new Array();

	for (var i = 0; i < genres.length; i += 2) {
		var name = genres[i+1];
		genreIds.push(genres[i]);
		genreNames.push(name ? name : "(Unspecified)");
	}

	var genresModel = new QStandardItemModel(genreIds.length, 2);
	for (var row = 0; row < genreIds.length; row++) {
		genresModel.setItem(row, 0, new QStandardItem(genreIds[row]));
		genresModel.setItem(row, 1, new QStandardItem(genreNames[row]));
	}

	var dialog = loader.load(file, Amarok.Window);

	function addGenre(item)
	{
		var idx = genreNames.indexOf(item.data());
		genresFilter.push(genreIds[idx]);
	}

	function ok()
	{
		enableRandom = dialog.enableRA.checked;
		pathFilter = dialog.pathFilter.text;
		var selectedIndexes = dialog.genresList.selectionModel().selectedIndexes();
		genresFilter = new Array();
		selectedIndexes.forEach(addGenre);
		Amarok.Script.writeConfig("enable", enableRandom ? "true" : "false");
		Amarok.Script.writeConfig("pathFilter", pathFilter);
		Amarok.Script.writeConfig("genresFilter", genresFilter.join(","));
		dialog.close();
	}

	function search()
	{
		var filedlg = new QFileDialog(dialog);
		filedlg.fileMode = QFileDialog.DirectoryOnly;
		filedlg.acceptMode = QFileDialog.AcceptOpen;
		if (filedlg.exec()) {
			dialog.pathFilter.text = filedlg.directory().absolutePath();
		}
	}

	dialog.enableRA.setChecked(enableRandom);
	dialog.pathFilter.text = pathFilter;
	dialog.genresList.setModel(genresModel);
	dialog.genresList.modelColumn = 1;
	dialog.genresList.selectionModel().clear();
	for (var i = 0; i < genresModel.rowCount(); i++) {
		if (genresFilter.indexOf(genresModel.index(i, 0).data()) >= 0) {
			dialog.genresList.selectionModel().select(genresModel.index(i, 1),
													  QItemSelectionModel.Select);
		}
	}
	dialog.buttonBox.accepted.connect(ok);
	dialog.searchBtn['clicked()'].connect(search);
	dialog.exec();
}


/*
 * When the script loads, make sure we have the random album view
 * in its latest version.
 */
Amarok.Collection.query(ALBUM_VIEW_1);
Amarok.Collection.query(ALBUM_VIEW_2);

Amarok.Engine.trackFinished.connect(trackFinished);

if (Amarok.Window.addToolsMenu("rand_album_load",
							   "Play Random Album",
							   "media-album-shuffle-amarok")) {
	Amarok.Window.ToolsMenu.rand_album_load['triggered()']
		.connect(playRandom);
}
if (Amarok.Window.addToolsMenu("rand_album_enqueue",
							   "Enqueue Random Album",
							   "media-album-shuffle-amarok")) {
	Amarok.Window.ToolsMenu.rand_album_enqueue['triggered()']
		.connect(randomize);
}

if (Amarok.Window.addSettingsMenu("rand_album_settings",
								  "Random Album Settings",
								  "media-album-shuffle-amarok")) {
	Amarok.Window.SettingsMenu.rand_album_settings['triggered()']
		.connect(showConfigDialog);
}

