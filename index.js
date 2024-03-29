#!/bin/node

const { titleCase } = require('title-case');
const _ = require('lodash');
const cheerio = require('cheerio');
const axios = require('axios');
const klaw = require('klaw');
const { orderBy } = require('natural-orderby');
const path = require('path');
const stringSimilarity = require('string-similarity');
const readline = require('readline');
const metadataWriter = require('./write-aac-metadata/dist/src').default;
const sequence = require('promise-sequence');
const fs = require('fs-extra');
const sharp = require('sharp');
const download = require('download');
const infobox = require('infobox-parser');

const mbApi = require('./musicbrainz');

let mbUrl = process.argv[2];
const albumArtUrl = process.argv[3];

const DEST = '/opt/media/music';
const SIMILARITY_WARNING = 0.9;
const ALBUM_ART_RESIZE = 1417;

const JSON_OPTIONS = {
  headers: {
    'Content-Type': 'application/json; charset=shift-jis',
    'Access-Control-Allow-Origin': '*',
    'accept-encoding': null,
    proxy: false,
    responseType: 'arraybuffer',
    responseEncoding: 'binary',
    gzip: true,
    encoding: null,
  },
};

async function askQuestion(query) {
  if (process.env.NAMER_AUTO === 'true') return Promise.resolve();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

async function setMeta(file, data) {
  console.log('Setting metadata,', file, data);
  return metadataWriter(file, data, undefined, { debug: false });
}

async function copyFile(src, dest) {
  console.log('Copying file', dest);
  return fs.copy(src, dest);
}

async function getFiles() {
  const items = [];

  return new Promise((resolve, reject) => {
    klaw('.', { depthLimit: 1 })
      .on('data', (item) => {
        if (item.path.endsWith('.m4a')) {
          const dirPath = path.dirname(item.path);
          const filename = path.basename(item.path);
          const name = path.basename(item.path, path.extname(item.path));
          let group = dirPath.substring(path.resolve('.').length);
          const discNumber = name.match(/^(\d+)-\d+/);
          if (group === '' && discNumber) {
            group = discNumber[1];
          }
          if (!items.find((item) => item.group === group))
            items.push({ group, items: [] });
          items
            .find((item) => item.group === group)
            .items.push({
              ...item,
              name,
              filename,
            });
        }
      })
      .on('end', () => {
        resolve(
          orderBy(items, (item) => item.group).map((item) => ({
            ...item,
            items: orderBy(item.items, (item) => item.name),
          }))
        );
      })
      .on('error', reject);
  });
}

function replaceSpecialChars(str, dir) {
  return dir ? str.replace(/[\/\.\$]/g, '_') : str.replace(/[\/\$]/g, '_');
}

function processGenres(genres) {
  let _genres = [];

  switch (typeof genres) {
    case 'string':
      _genres = [genres];
      break;
    case 'object':
      _genres = Array.isArray(genres) ? genres : [];
      break;
  }

  return _.uniq(
    _.flatten(_genres).map((genre) => {
      // strange edge case https://musicbrainz.org/release/60a04a88-3956-49f5-9d0f-b2603be9f612
      const _genreSplit = genre.split(/#/g);
      return titleCase(_genreSplit[_genreSplit.length - 1]);
    })
  );
}

function replaceStrangeChars(str) {
  return str
    .replace(/’/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‒]/g, '-')
    .replace(/×/g, 'x');
}

async function getMbData(url) {
  const release = await mbApi.lookupEntity(
    'release',
    url.match(/release\/(.*?)$/)[1],
    ['artists', 'recordings', 'release-groups', 'artist-credits']
  );
  const group = await mbApi.lookupEntity(
    'release-group',
    release['release-group'].id,
    ['genres', 'url-rels']
  );

  const artist = await mbApi.lookupEntity(
    'artist',
    release['artist-credit'].find((artist) => artist.joinphrase === '')?.artist
      .id || release['artist-credit'][0].artist.id,
    ['genres', 'url-rels']
  );

  const wikidataRel =
    group.relations.find((rel) => rel.type.toLowerCase() === 'wikidata') ||
    artist.relations.find((rel) => rel.type.toLowerCase() === 'wikidata');

  const wikipediaRel =
    group.relations.find((rel) => rel.type.toLowerCase() === 'wikipedia') ||
    artist.relations.find((rel) => rel.type.toLowerCase() === 'wikipedia');

  const artistName = replaceStrangeChars(artist.name);
  const albumTitle = replaceStrangeChars(release.title);
  const discs = release.media
    .filter(
      (media) =>
        media.format.toLowerCase() === release.media[0].format.toLowerCase()
    )
    .map((media) =>
      media.tracks.map((track) => {
        const trackArtists = track.recording['artist-credit'];
        const extra = trackArtists
          .map(
            (artist, i) =>
              `${i !== 0 ? artist.name : ''}${artist.joinphrase.replace(
                /&/,
                'with'
              )}`
          )
          .join('')
          .trim();
        return {
          artists: trackArtists.map((artist) => {
            let name = artist?.artist?.name || artist.name;
            if (name === '[no artist]') name = '';
            return replaceStrangeChars(name);
          }),
          title: replaceStrangeChars(track.title),
        };
        /*
	title: trackTitle(
          `${replaceStrangeChars(track.title)}${
            extra.length ? ` (${extra})` : ''
          }`
        ).replace(/Feat\./g, 'feat.')}
	*/
      })
    );

  const year = group['first-release-date'].match(/^\d{4}/)[0];
  const genres = _.uniq(
    (group.genres && group.genres.length
      ? group.genres
      : artist.genres && artist.genres.length
      ? artist.genres
      : []
    ).map((genre) => genre.name.trim())
  );

  return {
    id: release.id,
    artistId: artist.id,
    release: albumTitle,
    disambiguation: group.disambiguation || '',
    artist: artistName,
    wikipedia: wikipediaRel?.url?.resource,
    wikidata: wikidataRel?.url?.resource,
    discs,
    year,
    genres,
  };
}

async function getWikidata(url) {
  const entity = url.match(/\/(Q\d+$)/)[1];

  return axios
    .get(
      `https://www.wikidata.org/wiki/Special:EntityData/${entity}.json`,
      JSON_OPTIONS
    )
    .then((res) => {
      return (
        res.data?.entities?.[entity]?.sitelinks?.enwiki ||
        res.data?.entities?.[Object.keys(res.data?.entities)?.[0]]?.sitelinks
          ?.enwiki ||
        res.data?.entities?.[entity]?.sitelinks?.simplewiki ||
        res.data?.entities?.[Object.keys(res.data?.entities)?.[0]]?.sitelinks
          ?.simplewiki
      );
    });
}

function matchGenres(str) {
  const re = /\[\[.*?\]\]/g;
  var m;
  const genres = [];
  const _str = str.replace(/{{[\s\S]*?}}/g, '');
  do {
    m = re.exec(_str);
    if (m) {
      genres.push(m);
    }
  } while (m);
  return genres.join(', ');
}

async function getInfoBox(title) {
  return axios
    .get(
      `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&titles=${encodeURIComponent(
        title
      ).replace(/\s/g, '_')}&rvslots=main&rvsection=0`,
      JSON_OPTIONS
    )
    .then((res) => {
      let infoboxText = Object.values(res.data?.query?.pages || {})?.[0]
        ?.revisions?.[0]?.slots?.main?.['*'];
      infoboxText = infoboxText.replace(/<!--[\s\S]*?-->/g, '');
      infoboxText = infoboxText.replace(/^\*\s*{{.*?$/gm, '');
      infoboxText = infoboxText.replace(
        /genre\s*=\s*{{flatlist\|([\s\S]*?)}}(?=\n)/gim,
        (match, group) => {
          return `genre = ${matchGenres(group)}`;
        }
      );
      // infoboxText = infoboxText.replace(
      //   /genre\s*=\s*{{hlist\|([\s\S]*?)}}(?=\n)/gim,
      //   (match, group) => {
      //     return `genre = ${matchGenres(
      //       group
      //         .split(/(?<=\])\s*\|/g)
      //         .map((item) => item.trim())
      //         .filter((item) => item.match(/^\[\[/))
      //         .join(',')
      //     )}`;
      //   }
      // );
      return infobox(infoboxText, {
        removeSmall: true,
        removeReferences: true,
      });
    });
}

async function getArtistGenres(artist) {
  try {
    const infobox = await getInfoBox(artist);
    return processGenres(infobox?.general?.genre);
  } catch (e) {
    console.error(e);
    return [];
  }
}

async function getWikipediaData(title, artist) {
  try {
    const infobox = await getInfoBox(decodeURIComponent(title));
    const genres = processGenres(infobox?.general?.genre);
    const artistGenres = await getArtistGenres(
      infobox?.general?.artist || artist
    );

    return {
      genres:
        genres && genres.length
          ? genres
          : artistGenres && artistGenres.length
          ? artistGenres
          : [],
    };
  } catch (e) {
    console.log(e);
    return { genres: [] };
  }
}

async function run() {
  const files = await getFiles();

  const mbIdFileExists = await fs.exists('./mbid');
  const coverUrlFileExists = await fs.exists('./cover');

  if (mbIdFileExists) {
    mbUrl = `https://musicbrainz.org/release/${(
      await fs.readFile('./mbid', 'utf-8')
    ).trim()}`;
  }

  if (albumArtUrl || coverUrlFileExists) {
    const coverUrl =
      albumArtUrl || (await fs.readFile('./cover', 'utf-8')).trim();
    console.log('Downloading cover file', coverUrl);
    await download(coverUrl, '.', { filename: 'cover.jpg' });
  }

  const fullCoverExists = await fs.exists('./cover.full.jpg');
  const undersizedCoverExists = await fs.exists('./cover.undersized.jpg');
  const coverExists = await fs.exists('./cover.jpg');

  if (!coverExists && !fullCoverExists && !undersizedCoverExists) {
    console.log('cover file does not exist');
    process.exit();
  }

  const coverFile = fullCoverExists
    ? './cover.full.jpg'
    : undersizedCoverExists
    ? './cover.undersized.jpg'
    : './cover.jpg';

  console.log('Using cover file:', coverFile);
  const cover = await sharp(coverFile).jpeg({ quality: 100 });
  const coverMeta = await cover.metadata();

  let albumArtUndersized = false;
  let albumArtOversized = false;

  if (
    coverMeta.width < ALBUM_ART_RESIZE ||
    coverMeta.height < ALBUM_ART_RESIZE
  ) {
    albumArtUndersized = true;
    await askQuestion(
      `Album art undersized (${coverMeta.width} x ${coverMeta.height}), continue? `
    );
    console.log('Great, continuing...');
  } else {
    albumArtOversized = true;
  }

  if (albumArtOversized) {
    console.log('Resizing album art');
    cover.resize(ALBUM_ART_RESIZE, ALBUM_ART_RESIZE, { fit: 'fill' });
  } else if (coverMeta.width !== coverMeta.height) {
    const minSize = Math.min(coverMeta.width, coverMeta.height);
    cover.resize(minSize, minSize, { fit: 'fill' });
  }

  const mbData = await getMbData(mbUrl);
  const multipleArtists =
    mbData.artist.toLowerCase() === 'various artists' ||
    _.flatten(mbData.discs).some((track) => track.artists.length > 1);

  /*
  let wikipediaData = { genres: [] };

  if (mbData.wikidata || mbData.wikipedia) {
    let wikidata;

    if (mbData.wikidata && !mbData.wikipedia)
      wikidata = await getWikidata(mbData.wikidata);

    const title = wikidata?.title || mbData.wikipedia?.split(/wiki\//).pop();

    if (title) {
      wikipediaData = await getWikipediaData(title, mbData.artist);
    }
  }
  */

  function logDiscs() {
    console.log(
      mbData.discs.map((disc) =>
        disc.map(
          (track, i) =>
            `${i + 1} ${track.title}${
              track.artists.length > 1 ? ` [${track.artists.join(', ')}]` : ''
            }`
        )
      )
    );
  }

  function logTracks() {
    console.log('');
    console.log('Files:');
    console.log(files.map((dir) => dir.items.map((file) => file.name)));
    console.log('');
    console.log('MusicBrainz:');
    logDiscs();
  }

  let trackDiff = false;
  files.forEach((dir, i) => {
    if (!trackDiff && dir.items.length !== mbData.discs[i]?.length) {
      trackDiff = true;
    }
  });

  if (files.length !== mbData.discs.length || trackDiff) {
    console.log('Number of tracks does not match');
    logTracks();
    process.exit();
  }

  const trackSimilarity = files.map((dir, i) =>
    dir.items.map((file, j) =>
      stringSimilarity.compareTwoStrings(
        file.name.toLowerCase().replace(/^(\d+-)?\d+\.?\s*-?\s*/, ''),
        replaceSpecialChars(mbData.discs[i][j].title.toLowerCase())
      )
    )
  );

  const similarityWarning = _.flatten(trackSimilarity).some(
    (sim) => sim < SIMILARITY_WARNING
  );

  if (similarityWarning) {
    console.log('Tracks do not look alike');
    console.log('');
    console.log('Similarity:');
    console.log(
      trackSimilarity.map((disc) => disc.map((s, i) => `${i + 1} - ${s}`))
    );
    logTracks();
    await askQuestion('Continue? ');
    console.log('Great, continuing...');
  }

  console.log('Verify metadata:');
  console.log('');
  console.log('Artist:', multipleArtists ? 'Multiple Artists' : mbData.artist);
  if (multipleArtists) console.log('Album Artist:', mbData.artist);
  console.log('Album:', mbData.release);
  console.log('Year:', mbData.year);
  console.log('Genres:', mbData.genres);
  console.log('Tracks:');
  logDiscs();

  await askQuestion('All OK? ');

  console.log('Great, continuing...');

  const discCount = mbData.discs.length;

  await cover.toFile('cover.embed.jpg');

  await sequence(
    _.flatten(
      mbData.discs.map((disc, i) =>
        disc.map(
          (track, j) => () =>
            setMeta(files[i].items[j].path, {
              artist: track.artists.join('; '),
              albumArtist: mbData.artist,
              title: track.title,
              album: mbData.release,
              year: mbData.year,
              genre: mbData.genres.join(', '),
              track: j + 1,
              ...(discCount > 1 ? { disc: i + 1 } : {}),
              coverPicturePath: 'cover.embed.jpg',
            })
        )
      )
    )
  );

  const artistDest = `${DEST}/${replaceSpecialChars(mbData.artist, true)}`;

  const albumDest = `${artistDest}/${replaceSpecialChars(
    `${mbData.release}${
      mbData.disambiguation.length ? ` (${mbData.disambiguation})` : ''
    }`,
    true
  )}`;

  await sequence(
    _.flatten(
      mbData.discs.map((disc, i) =>
        disc.map(
          (track, j) => () =>
            copyFile(
              files[i].items[j].path,
              `${albumDest}/${discCount > 1 ? `${i + 1}-` : ''}${String(
                j + 1
              ).padStart(2, '0')} ${replaceSpecialChars(track.title)}.m4a`
            )
        )
      )
    )
  );

  console.log('Saving cover', `${albumDest}/cover.jpg`);
  await cover.toFile(`${albumDest}/cover.jpg`);

  copyFile(
    coverFile,
    `${albumDest}/cover.${albumArtOversized ? 'full' : 'undersized'}.jpg`
  );

  console.log('Saving mbid', `${albumDest}/mbid`);
  await fs.writeFile(`${albumDest}/mbid`, mbData.id, 'utf-8');

  console.log('Saving artist mbid', `${artistDest}/mbid`);
  await fs.writeFile(`${artistDest}/mbid`, mbData.artistId, 'utf-8');
}

run();
