const express = require('express');
const { db, getPlaceWithTags, canAccessTrip } = require('../db/database');
const { authenticate } = require('../middleware/auth');
const { broadcast } = require('../websocket');

const router = express.Router({ mergeParams: true });

function verifyTripOwnership(tripId, userId) {
  return canAccessTrip(tripId, userId);
}

// GET /api/trips/:tripId/places
router.get('/', authenticate, (req, res) => {
  const { tripId } = req.params;
  const { search, category, tag } = req.query;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  let query = `
    SELECT DISTINCT p.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM places p
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.trip_id = ?
  `;
  const params = [tripId];

  if (search) {
    query += ' AND (p.name LIKE ? OR p.address LIKE ? OR p.description LIKE ?)';
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam, searchParam);
  }

  if (category) {
    query += ' AND p.category_id = ?';
    params.push(category);
  }

  if (tag) {
    query += ' AND p.id IN (SELECT place_id FROM place_tags WHERE tag_id = ?)';
    params.push(tag);
  }

  query += ' ORDER BY p.created_at DESC';

  const places = db.prepare(query).all(...params);

  // Load all tags for these places in a single query to avoid N+1
  const placeIds = places.map(p => p.id);
  const tagsByPlaceId = {};
  if (placeIds.length > 0) {
    const placeholders = placeIds.map(() => '?').join(',');
    const allTags = db.prepare(`
      SELECT t.*, pt.place_id FROM tags t
      JOIN place_tags pt ON t.id = pt.tag_id
      WHERE pt.place_id IN (${placeholders})
    `).all(...placeIds);

    for (const tag of allTags) {
      const pid = tag.place_id;
      delete tag.place_id;
      if (!tagsByPlaceId[pid]) tagsByPlaceId[pid] = [];
      tagsByPlaceId[pid].push(tag);
    }
  }

  const placesWithTags = places.map(p => {
    return {
      ...p,
      category: p.category_id ? {
        id: p.category_id,
        name: p.category_name,
        color: p.category_color,
        icon: p.category_icon,
      } : null,
      tags: tagsByPlaceId[p.id] || [],
    };
  });

  res.json({ places: placesWithTags });
});

// POST /api/trips/:tripId/places
router.post('/', authenticate, (req, res) => {
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const {
    name, description, lat, lng, address, category_id, price, currency,
    place_time, end_time,
    duration_minutes, notes, image_url, google_place_id, website, phone,
    transport_mode, tags = []
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Place name is required' });
  }
  if (name && name.length > 200) return res.status(400).json({ error: 'Name too long (max 200 characters)' });
  if (description && description.length > 5000) return res.status(400).json({ error: 'Description too long (max 5000 characters)' });
  if (notes && notes.length > 10000) return res.status(400).json({ error: 'Notes too long (max 10000 characters)' });
  if (address && address.length > 500) return res.status(400).json({ error: 'Address too long (max 500 characters)' });
  if (website && website.length > 500) return res.status(400).json({ error: 'Website too long (max 500 characters)' });

  const result = db.prepare(`
    INSERT INTO places (trip_id, name, description, lat, lng, address, category_id, price, currency,
      place_time, end_time,
      duration_minutes, notes, image_url, google_place_id, website, phone, transport_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tripId, name, description || null, lat || null, lng || null, address || null,
    category_id || null, price || null, currency || null,
    place_time || null, end_time || null, duration_minutes || 60, notes || null, image_url || null,
    google_place_id || null, website || null, phone || null, transport_mode || 'walking'
  );

  const placeId = result.lastInsertRowid;

  if (tags && tags.length > 0) {
    const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
    for (const tagId of tags) {
      insertTag.run(placeId, tagId);
    }
  }

  const place = getPlaceWithTags(placeId);
  res.status(201).json({ place });
  broadcast(tripId, 'place:created', { place }, req.headers['x-socket-id']);
});

// GET /api/trips/:tripId/places/:id
router.get('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const placeCheck = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!placeCheck) {
    return res.status(404).json({ error: 'Place not found' });
  }

  const place = getPlaceWithTags(id);
  res.json({ place });
});

// GET /api/trips/:tripId/places/:id/image - fetch image from Unsplash
router.get('/:id/image', authenticate, async (req, res) => {
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const place = db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!place) {
    return res.status(404).json({ error: 'Place not found' });
  }

  const user = db.prepare('SELECT unsplash_api_key FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.unsplash_api_key) {
    return res.status(400).json({ error: 'No Unsplash API key configured' });
  }

  try {
    const query = encodeURIComponent(place.name + (place.address ? ' ' + place.address : ''));
    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${query}&per_page=5&client_id=${user.unsplash_api_key}`
    );
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.errors?.[0] || 'Unsplash API error' });
    }

    const photos = (data.results || []).map(p => ({
      id: p.id,
      url: p.urls?.regular,
      thumb: p.urls?.thumb,
      description: p.description || p.alt_description,
      photographer: p.user?.name,
      link: p.links?.html,
    }));

    res.json({ photos });
  } catch (err) {
    console.error('Unsplash error:', err);
    res.status(500).json({ error: 'Error searching for image' });
  }
});

// PUT /api/trips/:tripId/places/:id
router.put('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const existingPlace = db.prepare('SELECT * FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!existingPlace) {
    return res.status(404).json({ error: 'Place not found' });
  }

  const {
    name, description, lat, lng, address, category_id, price, currency,
    place_time, end_time,
    duration_minutes, notes, image_url, google_place_id, website, phone,
    transport_mode, tags
  } = req.body;

  if (name && name.length > 200) return res.status(400).json({ error: 'Name too long (max 200 characters)' });
  if (description && description.length > 5000) return res.status(400).json({ error: 'Description too long (max 5000 characters)' });
  if (notes && notes.length > 10000) return res.status(400).json({ error: 'Notes too long (max 10000 characters)' });
  if (address && address.length > 500) return res.status(400).json({ error: 'Address too long (max 500 characters)' });
  if (website && website.length > 500) return res.status(400).json({ error: 'Website too long (max 500 characters)' });

  db.prepare(`
    UPDATE places SET
      name = COALESCE(?, name),
      description = ?,
      lat = ?,
      lng = ?,
      address = ?,
      category_id = ?,
      price = ?,
      currency = COALESCE(?, currency),
      place_time = ?,
      end_time = ?,
      duration_minutes = COALESCE(?, duration_minutes),
      notes = ?,
      image_url = ?,
      google_place_id = ?,
      website = ?,
      phone = ?,
      transport_mode = COALESCE(?, transport_mode),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    name || null,
    description !== undefined ? description : existingPlace.description,
    lat !== undefined ? lat : existingPlace.lat,
    lng !== undefined ? lng : existingPlace.lng,
    address !== undefined ? address : existingPlace.address,
    category_id !== undefined ? category_id : existingPlace.category_id,
    price !== undefined ? price : existingPlace.price,
    currency || null,
    place_time !== undefined ? place_time : existingPlace.place_time,
    end_time !== undefined ? end_time : existingPlace.end_time,
    duration_minutes || null,
    notes !== undefined ? notes : existingPlace.notes,
    image_url !== undefined ? image_url : existingPlace.image_url,
    google_place_id !== undefined ? google_place_id : existingPlace.google_place_id,
    website !== undefined ? website : existingPlace.website,
    phone !== undefined ? phone : existingPlace.phone,
    transport_mode || null,
    id
  );

  if (tags !== undefined) {
    db.prepare('DELETE FROM place_tags WHERE place_id = ?').run(id);
    if (tags.length > 0) {
      const insertTag = db.prepare('INSERT OR IGNORE INTO place_tags (place_id, tag_id) VALUES (?, ?)');
      for (const tagId of tags) {
        insertTag.run(id, tagId);
      }
    }
  }

  const place = getPlaceWithTags(id);
  res.json({ place });
  broadcast(tripId, 'place:updated', { place }, req.headers['x-socket-id']);
});

// DELETE /api/trips/:tripId/places/:id
router.delete('/:id', authenticate, (req, res) => {
  const { tripId, id } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  const place = db.prepare('SELECT id FROM places WHERE id = ? AND trip_id = ?').get(id, tripId);
  if (!place) {
    return res.status(404).json({ error: 'Place not found' });
  }

  db.prepare('DELETE FROM places WHERE id = ?').run(id);
  res.json({ success: true });
  broadcast(tripId, 'place:deleted', { placeId: Number(id) }, req.headers['x-socket-id']);
});

module.exports = router;
