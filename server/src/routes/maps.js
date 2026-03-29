const express = require('express');
const { db } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const aircodes = require('aircodes');

const router = express.Router();

// Pre-load all airports once for fast prefix search
const ALL_AIRPORTS = aircodes.findAirport('');

// Get API key: user's own key, or fall back to any admin's key
function getAviationKey(userId) {
  const user = db.prepare('SELECT aviation_api_key FROM users WHERE id = ?').get(userId);
  if (user?.aviation_api_key) return user.aviation_api_key;
  const admin = db.prepare("SELECT aviation_api_key FROM users WHERE role = 'admin' AND aviation_api_key IS NOT NULL AND aviation_api_key != '' LIMIT 1").get();
  return admin?.aviation_api_key || null;
}

function getMapsKey(userId) {
  const user = db.prepare('SELECT maps_api_key FROM users WHERE id = ?').get(userId);
  if (user?.maps_api_key) return user.maps_api_key;
  const admin = db.prepare("SELECT maps_api_key FROM users WHERE role = 'admin' AND maps_api_key IS NOT NULL AND maps_api_key != '' LIMIT 1").get();
  return admin?.maps_api_key || null;
}

function getAnthropicKey(userId) {
  const user = db.prepare('SELECT anthropic_api_key FROM users WHERE id = ?').get(userId);
  if (user?.anthropic_api_key) return user.anthropic_api_key;
  const admin = db.prepare("SELECT anthropic_api_key FROM users WHERE role = 'admin' AND anthropic_api_key IS NOT NULL AND anthropic_api_key != '' LIMIT 1").get();
  return admin?.anthropic_api_key || null;
}

// In-memory photo cache: placeId → { photoUrl, attribution, fetchedAt }
const photoCache = new Map();
const PHOTO_TTL = 12 * 60 * 60 * 1000; // 12 hours

// Flight cache: dual-layer (in-memory + SQLite)
// Flight schedules for a given number+date are effectively immutable,
// so we cache aggressively: 7 days in-memory, 30 days in SQLite.
const flightCache = new Map();
const FLIGHT_MEM_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 days in-memory
const FLIGHT_DB_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days in SQLite

function getFlightFromCache(key) {
  // Layer 1: in-memory
  const mem = flightCache.get(key);
  if (mem && Date.now() - mem.fetchedAt < FLIGHT_MEM_TTL) {
    return mem.data;
  }

  // Layer 2: SQLite
  try {
    const row = db.prepare('SELECT response_json, fetched_at FROM flight_cache WHERE cache_key = ?').get(key);
    if (row && Date.now() - row.fetched_at < FLIGHT_DB_TTL) {
      const data = JSON.parse(row.response_json);
      // Promote back to memory cache
      flightCache.set(key, { data, fetchedAt: row.fetched_at });
      return data;
    }
  } catch { /* table may not exist yet before migration runs */ }

  return null;
}

function setFlightCache(key, data) {
  const now = Date.now();
  // Layer 1: in-memory
  flightCache.set(key, { data, fetchedAt: now });

  // Layer 2: SQLite (persist for restarts)
  try {
    db.prepare(
      'INSERT OR REPLACE INTO flight_cache (cache_key, response_json, fetched_at) VALUES (?, ?, ?)'
    ).run(key, JSON.stringify(data), now);
  } catch { /* ignore if table doesn't exist yet */ }

  // Prune old SQLite entries occasionally (1 in 20 writes)
  if (Math.random() < 0.05) {
    try {
      db.prepare('DELETE FROM flight_cache WHERE fetched_at < ?').run(now - FLIGHT_DB_TTL);
    } catch { /* ignore */ }
  }
}

// Place info cache: dual-layer (in-memory + SQLite) for Wikipedia/Wikidata enrichment
const placeInfoCache = new Map();
const PLACE_INFO_MEM_TTL = 30 * 24 * 60 * 60 * 1000;  // 30 days in-memory
const PLACE_INFO_DB_TTL = 30 * 24 * 60 * 60 * 1000;    // 30 days in SQLite

function getPlaceInfoFromCache(key) {
  // Layer 1: in-memory
  const mem = placeInfoCache.get(key);
  if (mem && Date.now() - mem.fetchedAt < PLACE_INFO_MEM_TTL) {
    return mem.data;
  }

  // Layer 2: SQLite
  try {
    const row = db.prepare('SELECT summary, facts_json, image_url, wikipedia_url, fetched_at FROM place_info_cache WHERE cache_key = ?').get(key);
    if (row && Date.now() - row.fetched_at < PLACE_INFO_DB_TTL) {
      const data = {
        summary: row.summary,
        facts: row.facts_json ? JSON.parse(row.facts_json) : null,
        imageUrl: row.image_url,
        wikipediaUrl: row.wikipedia_url,
      };
      // Promote back to memory cache
      placeInfoCache.set(key, { data, fetchedAt: row.fetched_at });
      return data;
    }
  } catch { /* table may not exist yet before migration runs */ }

  return null;
}

function setPlaceInfoCache(key, data) {
  const now = Date.now();
  // Layer 1: in-memory
  placeInfoCache.set(key, { data, fetchedAt: now });

  // Layer 2: SQLite (persist for restarts)
  try {
    db.prepare(
      'INSERT OR REPLACE INTO place_info_cache (cache_key, name, lang, summary, facts_json, image_url, wikipedia_url, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(key, data.name || '', data.lang || 'en', data.summary || null, data.facts ? JSON.stringify(data.facts) : null, data.imageUrl || null, data.wikipediaUrl || null, now);
  } catch { /* ignore if table doesn't exist yet */ }

  // Prune old SQLite entries occasionally (1 in 20 writes)
  if (Math.random() < 0.05) {
    try {
      db.prepare('DELETE FROM place_info_cache WHERE fetched_at < ?').run(now - PLACE_INFO_DB_TTL);
    } catch { /* ignore */ }
  }
}

// Strip parentheticals like "(city)" from a title for fallback Wikipedia lookup
function stripParentheticals(title) {
  return title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getPlaceInfo(name, lang = 'en') {
  const cacheKey = `${lang}:${name}`;
  const cached = getPlaceInfoFromCache(cacheKey);
  if (cached !== null) return cached;

  const title = encodeURIComponent(name);
  const langPrefix = lang === 'en' ? 'en' : lang;

  let summary = null;
  let imageUrl = null;
  let wikipediaUrl = null;
  let wikidataId = null;

  // Try Wikipedia REST API summary
  try {
    const url = lang === 'en'
      ? `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`
      : `https://${langPrefix}.wikipedia.org/api/rest_v1/page/summary/${title}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NOMAD Travel Planner (https://github.com/mauriceboe/NOMAD)' },
    });

    if (response.ok) {
      const data = await response.json();
      summary = data.extract || null;
      imageUrl = data.thumbnail?.source || null;
      wikipediaUrl = data.content_urls?.desktop?.page || null;
      wikidataId = data.wikidata_id || null;
    } else if (response.status === 404 && lang === 'en') {
      // Fallback: try stripping parentheticals
      const stripped = stripParentheticals(name);
      if (stripped !== name) {
        return getPlaceInfo(stripped, lang);
      }
    }
  } catch { /* ignore fetch errors */ }

  // Fetch Wikidata for additional facts if we have a wikidata_id
  let facts = null;
  if (wikidataId) {
    try {
      const wdResponse = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=claims`,
        { headers: { 'User-Agent': 'NOMAD Travel Planner (https://github.com/mauriceboe/NOMAD)' } }
      );
      if (wdResponse.ok) {
        const wdData = await wdResponse.json();
        const entity = wdData.entities?.[wikidataId];
        if (entity?.claims) {
          const claims = entity.claims;
          const getValue = (prop) => {
            const cv = claims[prop]?.[0]?.mainsnak?.datavalue?.value;
            return cv !== undefined ? cv : null;
          };
          const population = getValue('P1082');
          const elevation = getValue('P2046');
          const timezone = getValue('P421');
          // UNESCO status: P757 = "World Heritage Site", P2610 = "UNESCO ID" or check P1799
          const hasUnesco = claims['P757'] || claims['P1799'] || claims['P2610'];
          // Continent: P30
          const continentId = getValue('P30');
          let continent = null;
          if (continentId) {
            try {
              const contResp = await fetch(
                `https://www.wikidata.org/wiki/Special:EntityData/${continentId}.json`,
                { headers: { 'User-Agent': 'NOMAD Travel Planner (https://github.com/mauriceboe/NOMAD)' } }
              );
              if (contResp.ok) {
                const contData = await contResp.json();
                continent = contData.entities?.[continentId]?.labels?.[lang]?.value ||
                  contData.entities?.[continentId]?.labels?.en?.value || null;
              }
            } catch { /* ignore */ }
          }
          facts = {
            population: population != null ? Number(population) : null,
            elevation: elevation != null ? Number(elevation) : null,
            timezone: timezone || null,
            isUNESCO: !!hasUnesco,
            continent: continent || null,
          };
        }
      }
    } catch { /* ignore Wikidata errors */ }
  }

  const result = { summary, facts, imageUrl, wikipediaUrl, name, lang };
  setPlaceInfoCache(cacheKey, result);
  return result;
}

// Nominatim search (OpenStreetMap) — free fallback when no Google API key
async function searchNominatim(query, lang) {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    limit: '10',
    'accept-language': lang || 'en',
  });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': 'NOMAD Travel Planner (https://github.com/mauriceboe/NOMAD)' },
  });
  if (!response.ok) throw new Error('Nominatim API error');
  const data = await response.json();
  return data.map(item => ({
    google_place_id: null,
    osm_id: `${item.osm_type}/${item.osm_id}`,
    name: item.name || item.display_name?.split(',')[0] || '',
    address: item.display_name || '',
    lat: parseFloat(item.lat) || null,
    lng: parseFloat(item.lon) || null,
    rating: null,
    website: null,
    phone: null,
    source: 'openstreetmap',
  }));
}

// POST /api/maps/search
router.post('/search', authenticate, async (req, res) => {
  const { query } = req.body;

  if (!query) return res.status(400).json({ error: 'Search query is required' });

  const apiKey = getMapsKey(req.user.id);

  // No Google API key → use Nominatim (OpenStreetMap)
  if (!apiKey) {
    try {
      const places = await searchNominatim(query, /^[a-z]{2,5}(-[A-Za-z]{2,5})?$/.test(req.query.lang) ? req.query.lang : 'en');
      return res.json({ places, source: 'openstreetmap' });
    } catch (err) {
      console.error('Nominatim search error:', err);
      return res.status(500).json({ error: 'OpenStreetMap search error' });
    }
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.websiteUri,places.nationalPhoneNumber,places.types',
      },
      body: JSON.stringify({ textQuery: query, languageCode: /^[a-z]{2,5}(-[A-Za-z]{2,5})?$/.test(req.query.lang) ? req.query.lang : 'en' }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Google Places API error' });
    }

    const places = (data.places || []).map(p => ({
      google_place_id: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      lat: p.location?.latitude || null,
      lng: p.location?.longitude || null,
      rating: p.rating || null,
      website: p.websiteUri || null,
      phone: p.nationalPhoneNumber || null,
      source: 'google',
    }));

    res.json({ places, source: 'google' });
  } catch (err) {
    console.error('Maps search error:', err);
    res.status(500).json({ error: 'Google Places search error' });
  }
});

// GET /api/maps/details/:placeId
router.get('/details/:placeId', authenticate, async (req, res) => {
  const { placeId } = req.params;

  if (!/^[A-Za-z0-9_\-]+$/.test(placeId)) return res.status(400).json({ error: 'Invalid place ID' });

  const apiKey = getMapsKey(req.user.id);
  if (!apiKey) {
    return res.status(400).json({ error: 'Google Maps API key not configured' });
  }

  try {
    const lang = /^[a-z]{2,5}(-[A-Za-z]{2,5})?$/.test(req.query.lang) ? req.query.lang : 'de';
    const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=${lang}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,rating,userRatingCount,websiteUri,nationalPhoneNumber,regularOpeningHours,googleMapsUri,reviews,editorialSummary',
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Google Places API error' });
    }

    const place = {
      google_place_id: data.id,
      name: data.displayName?.text || '',
      address: data.formattedAddress || '',
      lat: data.location?.latitude || null,
      lng: data.location?.longitude || null,
      rating: data.rating || null,
      rating_count: data.userRatingCount || null,
      website: data.websiteUri || null,
      phone: data.nationalPhoneNumber || null,
      opening_hours: data.regularOpeningHours?.weekdayDescriptions || null,
      open_now: data.regularOpeningHours?.openNow ?? null,
      google_maps_url: data.googleMapsUri || null,
      summary: data.editorialSummary?.text || null,
      reviews: (data.reviews || []).slice(0, 5).map(r => ({
        author: r.authorAttribution?.displayName || null,
        rating: r.rating || null,
        text: r.text?.text || null,
        time: r.relativePublishTimeDescription || null,
        photo: r.authorAttribution?.photoUri || null,
      })),
    };

    res.json({ place });
  } catch (err) {
    console.error('Maps details error:', err);
    res.status(500).json({ error: 'Error fetching place details' });
  }
});

// GET /api/maps/place-photo/:placeId
// Proxies a Google Places photo (hides API key from client). Returns { photoUrl, attribution }.
router.get('/place-photo/:placeId', authenticate, async (req, res) => {
  const { placeId } = req.params;

  if (!/^[A-Za-z0-9_\-]+$/.test(placeId)) return res.status(400).json({ error: 'Invalid place ID' });

  // Check TTL cache
  const cached = photoCache.get(placeId);
  if (cached && Date.now() - cached.fetchedAt < PHOTO_TTL) {
    return res.json({ photoUrl: cached.photoUrl, attribution: cached.attribution });
  }

  const apiKey = getMapsKey(req.user.id);
  if (!apiKey) {
    return res.status(400).json({ error: 'Google Maps API key not configured' });
  }

  try {
    // Fetch place details to get photo reference
    const detailsRes = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'photos',
      },
    });
    const details = await detailsRes.json();

    if (!detailsRes.ok) {
      console.error('Google Places photo details error:', details.error?.message || detailsRes.status);
      return res.status(404).json({ error: 'Photo could not be retrieved' });
    }

    if (!details.photos?.length) {
      return res.status(404).json({ error: 'No photo available' });
    }

    const photo = details.photos[0];
    const photoName = photo.name;
    const attribution = photo.authorAttributions?.[0]?.displayName || null;

    // Fetch the media URL (skipHttpRedirect returns JSON with photoUri)
    const mediaRes = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=600&key=${apiKey}&skipHttpRedirect=true`
    );
    const mediaData = await mediaRes.json();
    const photoUrl = mediaData.photoUri;

    if (!photoUrl) {
      return res.status(404).json({ error: 'Photo URL not available' });
    }

    photoCache.set(placeId, { photoUrl, attribution, fetchedAt: Date.now() });

    // Persist the photo URL to all places with this google_place_id so future
    // loads serve image_url directly without hitting the Google API again.
    try {
      db.prepare(
        'UPDATE places SET image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE google_place_id = ? AND (image_url IS NULL OR image_url = ?)'
      ).run(photoUrl, placeId, '');
    } catch (dbErr) {
      console.error('Failed to persist photo URL to database:', dbErr);
    }

    res.json({ photoUrl, attribution });
  } catch (err) {
    console.error('Place photo error:', err);
    res.status(500).json({ error: 'Error fetching photo' });
  }
});

// GET /api/maps/airports?q=...
// Searches airports by IATA code, name, or city
router.get('/airports', authenticate, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ airports: [] });

  const upper = q.toUpperCase();
  const lower = q.toLowerCase();
  const results = [];
  const seen = new Set();

  const add = (ap) => {
    if (!ap.iata || seen.has(ap.iata)) return;
    seen.add(ap.iata);
    results.push(ap);
  };

  // Exact IATA match first
  if (q.length <= 4) {
    const exact = aircodes.getAirportByIata(upper);
    if (exact) add(exact);
  }

  // IATA prefix matches (e.g. "FR" → FRA)
  if (q.length <= 3) {
    for (const ap of ALL_AIRPORTS) {
      if (results.length >= 15) break;
      if (ap.iata && ap.iata.startsWith(upper)) add(ap);
    }
  }

  // Name/city search — prefer exact city match, then startsWith, then includes
  if (results.length < 15) {
    const exactCity = [];
    const startsCity = [];
    const rest = [];
    for (const ap of ALL_AIRPORTS) {
      const cl = ap.city?.toLowerCase() || '';
      const nl = ap.name?.toLowerCase() || '';
      if (cl === lower) exactCity.push(ap);
      else if (cl.startsWith(lower) || nl.startsWith(lower)) startsCity.push(ap);
      else if (cl.includes(lower) || nl.includes(lower)) rest.push(ap);
    }
    for (const bucket of [exactCity, startsCity, rest]) {
      for (const ap of bucket) {
        if (results.length >= 15) break;
        add(ap);
      }
    }
  }

  res.json({
    airports: results.map(ap => ({
      iata: ap.iata,
      name: ap.name,
      city: ap.city,
      country: ap.country,
    })),
  });
});

// GET /api/maps/airline?code=LH
// Looks up airline by IATA code (typically parsed from flight number)
router.get('/airline', authenticate, (req, res) => {
  const code = (req.query.code || '').trim().toUpperCase();
  if (!code || code.length < 2 || code.length > 3) return res.json({ airline: null });

  // Get all airlines with this IATA code
  const allMatches = aircodes.findAirline(code).filter(a => a.iata === code);

  if (allMatches.length === 0) {
    return res.json({ airline: null });
  }

  // Prefer the passenger airline over cargo (heuristic: skip names containing "Cargo", "Freight")
  const passenger = allMatches.find(a => !/cargo|freight/i.test(a.name));
  const best = passenger || allMatches[0];

  res.json({
    airline: {
      iata: best.iata,
      name: best.name,
      logo: best.logo || null,
    },
  });
});

// GET /api/maps/flight?number=LH123&date=2026-04-15
// Looks up flight schedule via AeroDataBox (RapidAPI)
router.get('/flight', authenticate, async (req, res) => {
  const flightNumber = (req.query.number || '').trim().toUpperCase();
  const date = (req.query.date || '').trim();

  if (!flightNumber) return res.status(400).json({ error: 'Flight number is required' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date is required (YYYY-MM-DD)' });

  const apiKey = getAviationKey(req.user.id);
  if (!apiKey) {
    return res.status(400).json({ error: 'Aviation API key not configured. Add an AeroDataBox (RapidAPI) key in admin settings.' });
  }

  // Normalize flight number: "LH 123" → "LH123", "LH0123" → "LH123"
  const normalized = flightNumber.replace(/\s+/g, '');
  const cacheKey = `${normalized}:${date}`;

  // Check cache first (avoids API call entirely)
  const cached = getFlightFromCache(cacheKey);
  if (cached !== null) {
    return res.json(cached);
  }

  try {
    const response = await fetch(
      `https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(normalized)}/${date}`,
      {
        headers: {
          'x-rapidapi-key': apiKey,
          'x-rapidapi-host': 'aerodatabox.p.rapidapi.com',
        },
      }
    );

    if (response.status === 404) {
      const result = { flight: null };
      setFlightCache(cacheKey, result);
      return res.json(result);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error(`AeroDataBox API error (${response.status}):`, errText);
      return res.status(response.status).json({ error: 'Flight lookup failed' });
    }

    const flights = await response.json();
    if (!Array.isArray(flights) || flights.length === 0) {
      const result = { flight: null };
      setFlightCache(cacheKey, result);
      return res.json(result);
    }

    // Take the first (most relevant) result
    const f = flights[0];

    const flight = {
      flight_number: normalized,
      airline: f.airline?.name || null,
      departure_airport: null,
      arrival_airport: null,
      departure_time: null,
      arrival_time: null,
    };

    if (f.departure?.airport) {
      const depIata = f.departure.airport.iata || '';
      const depName = f.departure.airport.name || '';
      const depCity = f.departure.airport.municipalityName || '';
      flight.departure_airport = depIata ? `${depIata} - ${depCity || depName}${depName && depCity ? ` (${depName})` : ''}` : depName;
      flight.departure_time = f.departure.scheduledTime?.local || f.departure.scheduledTimeLocal || null;
    }

    if (f.arrival?.airport) {
      const arrIata = f.arrival.airport.iata || '';
      const arrName = f.arrival.airport.name || '';
      const arrCity = f.arrival.airport.municipalityName || '';
      flight.arrival_airport = arrIata ? `${arrIata} - ${arrCity || arrName}${arrName && arrCity ? ` (${arrName})` : ''}` : arrName;
      flight.arrival_time = f.arrival.scheduledTime?.local || f.arrival.scheduledTimeLocal || null;
    }

    // Also resolve airline from aircodes if API didn't return it
    if (!flight.airline) {
      const codeMatch = normalized.match(/^([A-Z]{2})/);
      if (codeMatch) {
        const allMatches = aircodes.findAirline(codeMatch[1]).filter(a => a.iata === codeMatch[1]);
        const passenger = allMatches.find(a => !/cargo|freight/i.test(a.name));
        if (passenger) flight.airline = passenger.name;
      }
    }

    const result = { flight };
    setFlightCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Flight lookup error:', err);
    res.status(500).json({ error: 'Flight lookup error' });
  }
});

// GET /api/maps/place-info?search=...&lang=en
// Returns Wikipedia summary and key facts for a place name
router.get('/place-info', authenticate, async (req, res) => {
  const { search } = req.query;
  const lang = /^[a-z]{2,5}(-[A-Za-z]{2,5})?$/.test(req.query.lang) ? req.query.lang : 'en';

  if (!search || !search.trim()) {
    return res.status(400).json({ error: 'Search term is required' });
  }

  try {
    const data = await getPlaceInfo(search.trim(), lang);
    // Don't return 404 for missing data — just return what we have
    res.json(data);
  } catch (err) {
    console.error('Place info error:', err);
    res.status(500).json({ error: 'Error fetching place info' });
  }
});

module.exports = router;
