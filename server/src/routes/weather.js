const express = require('express');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// --------------- In-memory weather cache ---------------
const weatherCache = new Map();

const TTL_FORECAST_MS = 60 * 60 * 1000;   // 1 hour
const TTL_CURRENT_MS  = 15 * 60 * 1000;   // 15 minutes
const TTL_CLIMATE_MS  = 24 * 60 * 60 * 1000; // 24 hours (historical data doesn't change)

function cacheKey(lat, lng, date) {
  const rlat = parseFloat(lat).toFixed(2);
  const rlng = parseFloat(lng).toFixed(2);
  return `${rlat}_${rlng}_${date || 'current'}`;
}

function getCached(key) {
  const entry = weatherCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    weatherCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data, ttlMs) {
  weatherCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// WMO weather code mapping → condition string used by client icon map
const WMO_MAP = {
  0: 'Clear',
  1: 'Clear',          // mainly clear
  2: 'Clouds',         // partly cloudy
  3: 'Clouds',         // overcast
  45: 'Fog',
  48: 'Fog',
  51: 'Drizzle',
  53: 'Drizzle',
  55: 'Drizzle',
  56: 'Drizzle',       // freezing drizzle
  57: 'Drizzle',
  61: 'Rain',
  63: 'Rain',
  65: 'Rain',          // heavy rain
  66: 'Rain',          // freezing rain
  67: 'Rain',
  71: 'Snow',
  73: 'Snow',
  75: 'Snow',
  77: 'Snow',          // snow grains
  80: 'Rain',          // rain showers
  81: 'Rain',
  82: 'Rain',
  85: 'Snow',          // snow showers
  86: 'Snow',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
};

const WMO_DESCRIPTION_DE = {
  0: 'Klar',
  1: 'Überwiegend klar',
  2: 'Teilweise bewölkt',
  3: 'Bewölkt',
  45: 'Nebel',
  48: 'Nebel mit Reif',
  51: 'Leichter Nieselregen',
  53: 'Nieselregen',
  55: 'Starker Nieselregen',
  56: 'Gefrierender Nieselregen',
  57: 'Starker gefr. Nieselregen',
  61: 'Leichter Regen',
  63: 'Regen',
  65: 'Starker Regen',
  66: 'Gefrierender Regen',
  67: 'Starker gefr. Regen',
  71: 'Leichter Schneefall',
  73: 'Schneefall',
  75: 'Starker Schneefall',
  77: 'Schneekörner',
  80: 'Leichte Regenschauer',
  81: 'Regenschauer',
  82: 'Starke Regenschauer',
  85: 'Leichte Schneeschauer',
  86: 'Starke Schneeschauer',
  95: 'Gewitter',
  96: 'Gewitter mit Hagel',
  99: 'Starkes Gewitter mit Hagel',
};

const WMO_DESCRIPTION_EN = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Heavy freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snowfall',
  73: 'Snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Rain showers',
  82: 'Heavy rain showers',
  85: 'Light snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Severe thunderstorm with hail',
};

// Estimate weather condition from average temperature + precipitation
function estimateCondition(tempAvg, precipMm) {
  if (precipMm > 5) return tempAvg <= 0 ? 'Snow' : 'Rain';
  if (precipMm > 1) return tempAvg <= 0 ? 'Snow' : 'Drizzle';
  if (precipMm > 0.3) return 'Clouds';
  return tempAvg > 15 ? 'Clear' : 'Clouds';
}
// -------------------------------------------------------

// GET /api/weather?lat=&lng=&date=&lang=de
router.get('/', authenticate, async (req, res) => {
  const { lat, lng, date, lang = 'de' } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: 'Latitude and longitude are required' });
  }

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || latNum < -90 || latNum > 90) return res.status(400).json({ error: 'Invalid latitude' });
  if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) return res.status(400).json({ error: 'Invalid longitude' });
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

  const ck = cacheKey(latNum, lngNum, date);

  try {
    // ── Forecast for a specific date ──
    if (date) {
      const cached = getCached(ck);
      if (cached) return res.json(cached);

      const targetDate = new Date(date);
      const now = new Date();
      const diffDays = (targetDate - now) / (1000 * 60 * 60 * 24);

      // Within 16-day forecast window → real forecast
      if (diffDays >= -1 && diffDays <= 16) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latNum}&longitude=${lngNum}&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=16`;
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok || data.error) {
          return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo API error' });
        }

        const dateStr = targetDate.toISOString().slice(0, 10);
        const idx = (data.daily?.time || []).indexOf(dateStr);

        if (idx !== -1) {
          const code = data.daily.weathercode[idx];
          const descriptions = lang === 'de' ? WMO_DESCRIPTION_DE : WMO_DESCRIPTION_EN;

          const result = {
            temp: Math.round((data.daily.temperature_2m_max[idx] + data.daily.temperature_2m_min[idx]) / 2),
            temp_max: Math.round(data.daily.temperature_2m_max[idx]),
            temp_min: Math.round(data.daily.temperature_2m_min[idx]),
            main: WMO_MAP[code] || 'Clouds',
            description: descriptions[code] || '',
            type: 'forecast',
          };

          setCache(ck, result, TTL_FORECAST_MS);
          return res.json(result);
        }
        // Forecast didn't include this date — fall through to climate
      }

      // Beyond forecast range or forecast gap → historical climate average
      if (diffDays > -1) {
        const month = targetDate.getMonth() + 1;
        const day = targetDate.getDate();
        // Query a 5-day window around the target date for smoother averages (using last year as reference)
        const refYear = targetDate.getFullYear() - 1;
        const startDate = new Date(refYear, month - 1, day - 2);
        const endDate = new Date(refYear, month - 1, day + 2);
        const startStr = startDate.toISOString().slice(0, 10);
        const endStr = endDate.toISOString().slice(0, 10);

        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${latNum}&longitude=${lngNum}&start_date=${startStr}&end_date=${endStr}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
        const response = await fetch(url);
        const data = await response.json();

        if (!response.ok || data.error) {
          return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo Climate API error' });
        }

        const daily = data.daily;
        if (!daily || !daily.time || daily.time.length === 0) {
          return res.json({ error: 'no_forecast' });
        }

        // Average across the window
        let sumMax = 0, sumMin = 0, sumPrecip = 0, count = 0;
        for (let i = 0; i < daily.time.length; i++) {
          if (daily.temperature_2m_max[i] != null && daily.temperature_2m_min[i] != null) {
            sumMax += daily.temperature_2m_max[i];
            sumMin += daily.temperature_2m_min[i];
            sumPrecip += daily.precipitation_sum[i] || 0;
            count++;
          }
        }

        if (count === 0) {
          return res.json({ error: 'no_forecast' });
        }

        const avgMax = sumMax / count;
        const avgMin = sumMin / count;
        const avgTemp = (avgMax + avgMin) / 2;
        const avgPrecip = sumPrecip / count;
        const main = estimateCondition(avgTemp, avgPrecip);

        const result = {
          temp: Math.round(avgTemp),
          temp_max: Math.round(avgMax),
          temp_min: Math.round(avgMin),
          main,
          description: '',
          type: 'climate',
        };

        setCache(ck, result, TTL_CLIMATE_MS);
        return res.json(result);
      }

      // Past dates beyond yesterday
      return res.json({ error: 'no_forecast' });
    }

    // ── Current weather (no date) ──
    const cached = getCached(ck);
    if (cached) return res.json(cached);

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latNum}&longitude=${lngNum}&current=temperature_2m,weathercode&timezone=auto`;
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.error) {
      return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo API error' });
    }

    const code = data.current.weathercode;
    const descriptions = lang === 'de' ? WMO_DESCRIPTION_DE : WMO_DESCRIPTION_EN;

    const result = {
      temp: Math.round(data.current.temperature_2m),
      main: WMO_MAP[code] || 'Clouds',
      description: descriptions[code] || '',
      type: 'current',
    };

    setCache(ck, result, TTL_CURRENT_MS);
    res.json(result);
  } catch (err) {
    console.error('Weather error:', err);
    res.status(500).json({ error: 'Error fetching weather data' });
  }
});

// GET /api/weather/detailed?lat=&lng=&date=&lang=de
router.get('/detailed', authenticate, async (req, res) => {
  const { lat, lng, date, lang = 'de' } = req.query;

  if (!lat || !lng || !date) {
    return res.status(400).json({ error: 'Latitude, longitude, and date are required' });
  }

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (isNaN(latNum) || latNum < -90 || latNum > 90) return res.status(400).json({ error: 'Invalid latitude' });
  if (isNaN(lngNum) || lngNum < -180 || lngNum > 180) return res.status(400).json({ error: 'Invalid longitude' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });

  const ck = `detailed_${cacheKey(latNum, lngNum, date)}`;

  try {
    const cached = getCached(ck);
    if (cached) return res.json(cached);

    const targetDate = new Date(date);
    const now = new Date();
    const diffDays = (targetDate - now) / (1000 * 60 * 60 * 24);
    const dateStr = targetDate.toISOString().slice(0, 10);
    const descriptions = lang === 'de' ? WMO_DESCRIPTION_DE : WMO_DESCRIPTION_EN;

    // Beyond 16-day forecast window → archive API with hourly data from same date last year
    if (diffDays > 16) {
      const refYear = targetDate.getFullYear() - 1;
      const refDateStr = `${refYear}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;

      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${latNum}&longitude=${lngNum}`
        + `&start_date=${refDateStr}&end_date=${refDateStr}`
        + `&hourly=temperature_2m,precipitation,weathercode,windspeed_10m,relativehumidity_2m`
        + `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,windspeed_10m_max,sunrise,sunset`
        + `&timezone=auto`;
      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok || data.error) {
        return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo Climate API error' });
      }

      const daily = data.daily;
      const hourly = data.hourly;
      if (!daily || !daily.time || daily.time.length === 0) {
        return res.json({ error: 'no_forecast' });
      }

      const idx = 0;
      const code = daily.weathercode?.[idx];
      const avgMax = daily.temperature_2m_max[idx];
      const avgMin = daily.temperature_2m_min[idx];

      // Build hourly array
      const hourlyData = [];
      if (hourly?.time) {
        for (let i = 0; i < hourly.time.length; i++) {
          const hour = new Date(hourly.time[i]).getHours();
          const hCode = hourly.weathercode?.[i];
          hourlyData.push({
            hour,
            temp: Math.round(hourly.temperature_2m[i]),
            precipitation: hourly.precipitation?.[i] || 0,
            precipitation_probability: 0, // archive has no probability
            main: WMO_MAP[hCode] || 'Clouds',
            wind: Math.round(hourly.windspeed_10m?.[i] || 0),
            humidity: hourly.relativehumidity_2m?.[i] || 0,
          });
        }
      }

      // Format sunrise/sunset
      let sunrise = null, sunset = null;
      if (daily.sunrise?.[idx]) sunrise = daily.sunrise[idx].split('T')[1]?.slice(0, 5);
      if (daily.sunset?.[idx]) sunset = daily.sunset[idx].split('T')[1]?.slice(0, 5);

      const result = {
        type: 'climate',
        temp: Math.round((avgMax + avgMin) / 2),
        temp_max: Math.round(avgMax),
        temp_min: Math.round(avgMin),
        main: WMO_MAP[code] || estimateCondition((avgMax + avgMin) / 2, daily.precipitation_sum?.[idx] || 0),
        description: descriptions[code] || '',
        precipitation_sum: Math.round((daily.precipitation_sum?.[idx] || 0) * 10) / 10,
        wind_max: Math.round(daily.windspeed_10m_max?.[idx] || 0),
        sunrise,
        sunset,
        hourly: hourlyData,
      };

      setCache(ck, result, TTL_CLIMATE_MS);
      return res.json(result);
    }

    // Within 16-day forecast window → full forecast with hourly data
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latNum}&longitude=${lngNum}`
      + `&hourly=temperature_2m,precipitation_probability,precipitation,weathercode,windspeed_10m,relativehumidity_2m`
      + `&daily=temperature_2m_max,temperature_2m_min,weathercode,sunrise,sunset,precipitation_probability_max,precipitation_sum,windspeed_10m_max`
      + `&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.error) {
      return res.status(response.status || 500).json({ error: data.reason || 'Open-Meteo API error' });
    }

    const daily = data.daily;
    const hourly = data.hourly;

    if (!daily || !daily.time || daily.time.length === 0) {
      return res.json({ error: 'no_forecast' });
    }

    const dayIdx = 0; // We requested a single day
    const code = daily.weathercode[dayIdx];

    // Parse sunrise/sunset to HH:MM
    const formatTime = (isoStr) => {
      if (!isoStr) return '';
      const d = new Date(isoStr);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };

    // Build hourly array
    const hourlyData = [];
    if (hourly && hourly.time) {
      for (let i = 0; i < hourly.time.length; i++) {
        const h = new Date(hourly.time[i]).getHours();
        hourlyData.push({
          hour: h,
          temp: Math.round(hourly.temperature_2m[i]),
          precipitation_probability: hourly.precipitation_probability[i] || 0,
          precipitation: hourly.precipitation[i] || 0,
          main: WMO_MAP[hourly.weathercode[i]] || 'Clouds',
          wind: Math.round(hourly.windspeed_10m[i] || 0),
          humidity: Math.round(hourly.relativehumidity_2m[i] || 0),
        });
      }
    }

    const result = {
      type: 'forecast',
      temp: Math.round((daily.temperature_2m_max[dayIdx] + daily.temperature_2m_min[dayIdx]) / 2),
      temp_max: Math.round(daily.temperature_2m_max[dayIdx]),
      temp_min: Math.round(daily.temperature_2m_min[dayIdx]),
      main: WMO_MAP[code] || 'Clouds',
      description: descriptions[code] || '',
      sunrise: formatTime(daily.sunrise[dayIdx]),
      sunset: formatTime(daily.sunset[dayIdx]),
      precipitation_sum: daily.precipitation_sum[dayIdx] || 0,
      precipitation_probability_max: daily.precipitation_probability_max[dayIdx] || 0,
      wind_max: Math.round(daily.windspeed_10m_max[dayIdx] || 0),
      hourly: hourlyData,
    };

    setCache(ck, result, TTL_FORECAST_MS);
    return res.json(result);
  } catch (err) {
    console.error('Detailed weather error:', err);
    res.status(500).json({ error: 'Error fetching detailed weather data' });
  }
});

module.exports = router;
