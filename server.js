const express = require('express');
const axios = require('axios');
const querystring = require('querystring');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Initialize Twilio client
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Clean and validate phone number
function cleanPhoneNumber(phoneStr) {
  if (!phoneStr) return null;
  // Remove any quotes, spaces, or other characters
  return phoneStr.replace(/['"]/g, '').trim();
}

// Casey's phone number (using Chris's for testing)
const CASEY_PHONE = cleanPhoneNumber(process.env.CHRIS_PHONE);

// Debug phone numbers
console.log('🔍 Raw CHRIS_PHONE value:', JSON.stringify(process.env.CHRIS_PHONE));
console.log('🔍 Cleaned CASEY_PHONE will be:', JSON.stringify(CASEY_PHONE));
console.log('🔍 All phone env vars:', {
  CHRIS_PHONE: JSON.stringify(process.env.CHRIS_PHONE),
  CASEY_PHONE: JSON.stringify(process.env.CASEY_PHONE),
  TWILIO_PHONE_NUMBER: JSON.stringify(process.env.TWILIO_PHONE_NUMBER)
});

// Spotify token cache
let spotifyToken = null;
let tokenExpiresAt = null;

/**
 * Get Spotify access token
 */
async function getSpotifyToken() {
  if (spotifyToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return spotifyToken;
  }

  try {
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      querystring.stringify({
        grant_type: 'client_credentials'
      }), {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    spotifyToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - 60000;
    
    console.log('✅ Spotify token obtained successfully');
    return spotifyToken;
  } catch (error) {
    console.error('❌ Error getting Spotify token:', error.message);
    throw new Error('Failed to authenticate with Spotify');
  }
}

/**
 * Extract Spotify track ID from URL
 */
function extractSpotifyTrackId(url) {
  const patterns = [
    /https?:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/,
    /spotify:track:([a-zA-Z0-9]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

/**
 * Get track info from Spotify
 */
/**
 * Get track info from Spotify including genres and audio features
 */
async function getSpotifyTrackInfo(trackId) {
  try {
    const token = await getSpotifyToken();
    
    // Get basic track info
    const trackResponse = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    const track = trackResponse.data;
    const artistId = track.artists[0].id;
    const albumId = track.album.id;

    // Get album genres (preferred)
    let genres = [];
    try {
      const albumResponse = await axios.get(`https://api.spotify.com/v1/albums/${albumId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      genres = albumResponse.data.genres || [];
    } catch (error) {
      console.log('Album genres not available, trying artist genres...');
    }

    // Fallback to artist genres if album has none
    if (genres.length === 0) {
      try {
        const artistResponse = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        genres = artistResponse.data.genres || [];
      } catch (error) {
        console.log('Artist genres not available');
      }
    }

    // Get audio features (optional but great for analytics)
    let audioFeatures = {};
    try {
      const audioResponse = await axios.get(`https://api.spotify.com/v1/audio-features/${trackId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      audioFeatures = {
        danceability: audioResponse.data.danceability,
        energy: audioResponse.data.energy,
        valence: audioResponse.data.valence,
        tempo: Math.round(audioResponse.data.tempo)
      };
    } catch (error) {
      console.log('Audio features not available');
    }

    return {
      title: track.name,
      artist: track.artists.map(artist => artist.name).join(', '),
      album: track.album.name,
      genres: genres,
      ...audioFeatures
    };
  } catch (error) {
    console.error('❌ Error fetching Spotify track:', error.message);
    throw new Error('Failed to get track information');
  }
}

/**
 * Search for song on YouTube
 */
async function searchYouTube(artist, title) {
  try {
    const searchQuery = `${artist} ${title}`;
    
    const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: process.env.YOUTUBE_API_KEY,
        q: searchQuery,
        part: 'snippet',
        type: 'video',
        maxResults: 1,
        order: 'relevance'
      }
    });

    if (response.data.items && response.data.items.length > 0) {
      const video = response.data.items[0];
      return {
        title: video.snippet.title,
        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
        channel: video.snippet.channelTitle
      };
    } else {
      throw new Error('No YouTube results found');
    }
  } catch (error) {
    console.error('❌ Error searching YouTube:', error.message);
    throw new Error('Failed to find song on YouTube');
  }
}

/**
 * Send SMS message
 */
async function sendSMS(to, message) {
  try {
    const cleanFrom = cleanPhoneNumber(process.env.TWILIO_PHONE_NUMBER);
    console.log('🔍 Using FROM number:', cleanFrom);
    
    const result = await twilioClient.messages.create({
      body: message,
      from: cleanFrom,
      to: to
    });
    
    console.log(`📱 SMS sent to ${to}, SID: ${result.sid}`);
    return result;
  } catch (error) {
    console.error('❌ Error sending SMS:', error.message);
    throw new Error('Failed to send SMS');
  }
}

/**
 * Extract Spotify track ID from any message
 */
function findSpotifyUrl(message) {
  const trackId = extractSpotifyTrackId(message);
  return trackId;
}

/**
 * Handle incoming SMS messages
 */
app.post('/webhook/sms', async (req, res) => {
  try {
    const { From: fromNumber, Body: messageBody } = req.body;
    
    console.log(`📨 Received SMS from ${fromNumber}: ${messageBody}`);
    
    // Check if message contains a Spotify URL
    const spotifyTrackId = findSpotifyUrl(messageBody);
    
    if (!spotifyTrackId) {
      // Not a Spotify URL, send help message
      await sendSMS(fromNumber, 
        "Hi! Send me a Spotify song link and I'll convert it to YouTube and send it to Casey! 🎵"
      );
      return res.status(200).send('OK');
    }

    // Process the Spotify link
    try {
      console.log(`🎵 Processing Spotify track: ${spotifyTrackId}`);
      
      // Get track info from Spotify
      const trackInfo = await getSpotifyTrackInfo(spotifyTrackId);
      console.log(`✅ Found: ${trackInfo.title} by ${trackInfo.artist}`);
      
      // Search YouTube
      const youtubeResult = await searchYouTube(trackInfo.artist, trackInfo.title);
      console.log(`✅ Found on YouTube: ${youtubeResult.title}`);
      
      // Send confirmation to sender (commented out for testing)
      // await sendSMS(fromNumber, 
      //   `Found "${trackInfo.title}" by ${trackInfo.artist}. Sending to Casey now! 🎵`
      // );
      console.log(`✅ Would send confirmation to ${fromNumber}`);
      
      // Send YouTube link to Casey (Chris for testing)
      await sendSMS(CASEY_PHONE, 
        `🎵 Someone shared a song with you!\n\n"${trackInfo.title}" by ${trackInfo.artist}\n\n${youtubeResult.url}`
      );
      
      console.log(`✅ Successfully sent song to Casey`);
      
    } catch (error) {
      console.error('❌ Error processing song:', error.message);
      await sendSMS(fromNumber, 
        "Sorry, I couldn't process that song. Please try again! 🤔"
      );
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('❌ Error processing webhook:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

// Test endpoint for Spotify
app.get('/test-spotify/:trackId', async (req, res) => {
  try {
    const trackInfo = await getSpotifyTrackInfo(req.params.trackId);
    res.json({ success: true, track: trackInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test endpoint for full flow
app.get('/test-full/:trackId', async (req, res) => {
  try {
    const trackInfo = await getSpotifyTrackInfo(req.params.trackId);
    const youtubeResult = await searchYouTube(trackInfo.artist, trackInfo.title);
    
    res.json({ 
      success: true, 
      spotify: trackInfo, 
      youtube: youtubeResult 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Music Share Bot MVP is running!',
    status: 'ok'
  });
});

// Start server
app.listen(port, () => {
  console.log(`🎵 Music Share Bot listening on port ${port}`);
});