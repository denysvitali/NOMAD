const express = require('express');
const { db, canAccessTrip } = require('../db/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

function verifyTripOwnership(tripId, userId) {
  return canAccessTrip(tripId, userId);
}

// GET /api/trips/:tripId/companion-data
// Returns aggregated trip data for the Trip Companion mobile view
router.get('/', authenticate, async (req, res) => {
  const { tripId } = req.params;

  const trip = verifyTripOwnership(tripId, req.user.id);
  if (!trip) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  // Fetch trip basic info
  const tripData = db.prepare(`
    SELECT id, title, start_date, end_date, cover_image as cover_url
    FROM trips WHERE id = ?
  `).get(tripId);

  if (!tripData) {
    return res.status(404).json({ error: 'Trip not found' });
  }

  // Fetch all days with assignments
  const days = db.prepare(`
    SELECT id, day_number, title, date
    FROM days WHERE trip_id = ?
    ORDER BY day_number ASC
  `).all(tripId);

  if (days.length === 0) {
    return res.json({
      trip: tripData,
      days: [],
      reservations: [],
      accommodations: [],
      weather: {},
    });
  }

  const dayIds = days.map(d => d.id);
  const dayPlaceholders = dayIds.map(() => '?').join(',');

  // Fetch all assignments for all days
  const allAssignments = db.prepare(`
    SELECT da.id, da.day_id, da.order_index, da.assignment_time,
      p.id as place_id, p.name as place_name, p.lat, p.lng,
      p.address, p.category_id, p.place_time, p.end_time,
      c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM day_assignments da
    JOIN places p ON da.place_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE da.day_id IN (${dayPlaceholders})
    ORDER BY da.order_index ASC, da.created_at ASC
  `).all(...dayIds);

  // Group assignments by day_id
  const assignmentsByDayId = {};
  for (const a of allAssignments) {
    if (!assignmentsByDayId[a.day_id]) assignmentsByDayId[a.day_id] = [];
    assignmentsByDayId[a.day_id].push({
      id: a.id,
      order_index: a.order_index,
      place: {
        name: a.place_name,
        lat: a.lat,
        lng: a.lng,
        address: a.address,
        category: a.category_id ? {
          name: a.category_name,
          color: a.category_color,
          icon: a.category_icon,
        } : null,
        place_time: a.assignment_time || a.place_time,
        end_time: a.end_time,
      },
    });
  }

  // Build days with assignments
  const daysWithAssignments = days.map(day => ({
    id: day.id,
    day_number: day.day_number,
    title: day.title,
    date: day.date,
    assignments: assignmentsByDayId[day.id] || [],
  }));

  // Fetch reservations
  const reservations = db.prepare(`
    SELECT id, type, title, status, flight_number, airline,
      departure_airport, arrival_airport, reservation_time, confirmation_number,
      location
    FROM reservations
    WHERE trip_id = ?
    ORDER BY reservation_time ASC
  `).all(tripId);

  // Fetch accommodations
  const accommodations = db.prepare(`
    SELECT da.id, da.check_in, da.check_out,
      p.name as place_name, p.address as place_address
    FROM day_accommodations da
    JOIN places p ON da.place_id = p.id
    WHERE da.trip_id = ?
    ORDER BY da.check_in ASC
  `).all(tripId);

  const formattedAccommodations = accommodations.map(a => ({
    id: a.id,
    check_in: a.check_in,
    check_out: a.check_out,
    place: {
      name: a.place_name,
      address: a.place_address,
    },
  }));

  // Pre-fetch weather for all days (simplified: embed place lat/lng for client-side weather)
  // Server returns place coordinates so client can fetch weather
  const weather = {};

  // Build weather lookup by date using the first place with lat/lng for each day
  for (const day of daysWithAssignments) {
    if (day.date && day.assignments.length > 0) {
      const firstPlaceWithCoords = day.assignments.find(a => a.place.lat && a.place.lng);
      if (firstPlaceWithCoords) {
        weather[day.date] = {
          lat: firstPlaceWithCoords.place.lat,
          lng: firstPlaceWithCoords.place.lng,
        };
      }
    }
  }

  res.json({
    trip: tripData,
    days: daysWithAssignments,
    reservations,
    accommodations: formattedAccommodations,
    weather,
  });
});

module.exports = router;
