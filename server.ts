import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Body parser with 30mb limit for base64 photo/PDF uploads
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'timetable-parser' });
});

// Explicit PWA Manifest & Service Worker routes with proper MIME and Service-Worker-Allowed headers
app.get('/manifest.webmanifest', (_req, res) => {
  const manifestPath = path.resolve(__dirname, 'public', 'manifest.webmanifest');
  res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(manifestPath);
});

app.get('/sw.js', (_req, res) => {
  const swPath = path.resolve(__dirname, 'public', 'sw.js');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(swPath);
});

// Direct download endpoints for APK Icon, Android APK Package ZIP, and Standalone Mobile Launcher
app.get('/api/download-apk-icon', (req, res) => {
  const size = req.query.size === '192' ? '192' : '512';
  const fileName = size === '192' ? 'pwa-192x192.png' : 'pwa-512x512.png';
  const downloadName = `AR-BISWANATH-BEHERA-APK-Icon-${size}x${size}.png`;
  const iconPath = path.resolve(__dirname, 'public', fileName);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.download(iconPath, downloadName);
});

app.get('/api/download-apk-package', (_req, res) => {
  const zipPath = path.resolve(__dirname, 'public', 'RoutineHub-Android-APK-Package.zip');
  const downloadName = 'RoutineHub-AR-BISWANATH-BEHERA-Android-APK-Package.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.download(zipPath, downloadName);
});

app.get('/api/download-mobile-launcher', (_req, res) => {
  const launcherPath = path.resolve(__dirname, 'public', 'RoutineHub-AR-BISWANATH-BEHERA-MobileApp.html');
  const downloadName = 'RoutineHub-AR-BISWANATH-BEHERA-MobileApp.html';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.download(launcherPath, downloadName);
});

// Singleton AI instance & in-memory cache for instant repeat scans
let aiClient: GoogleGenAI | null = null;
function getAIClient(apiKey: string): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

const parseCache = new Map<string, any>();
const MAX_CACHE_ENTRIES = 30;

// Ultra-fast Timetable & Work Schedule parsing endpoint
app.post('/api/parse-timetable', async (req, res) => {
  const startTimeMs = Date.now();
  try {
    const { data, mimeType, filename } = req.body;

    if (!data) {
      return res.status(400).json({
        success: false,
        error: 'No file data received. Please provide a base64 encoded photo or PDF.',
      });
    }

    const validMimes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/heic',
      'image/gif',
      'application/pdf',
    ];

    const resolvedMime =
      mimeType && validMimes.includes(mimeType)
        ? mimeType
        : filename?.toLowerCase().endsWith('.pdf')
        ? 'application/pdf'
        : 'image/jpeg';

    const cleanBase64 = data.replace(/^data:[^;]+;base64,/, '');

    // Compute fast fingerprint for instant cache lookup
    const hashKey = crypto
      .createHash('sha256')
      .update(`${resolvedMime}:${cleanBase64.length}:${cleanBase64.slice(0, 4096)}:${cleanBase64.slice(-4096)}`)
      .digest('hex');

    if (parseCache.has(hashKey)) {
      const cachedResult = parseCache.get(hashKey);
      return res.json({
        ...cachedResult,
        cached: true,
        durationMs: Date.now() - startTimeMs,
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('GEMINI_API_KEY is not set in environment.');
      return res.status(500).json({
        success: false,
        error: 'AI service configuration missing (GEMINI_API_KEY).',
      });
    }

    const ai = getAIClient(apiKey);

    const promptText = `Fast-extract this schedule image or PDF.
1. Classify scheduleType: "college" (university/school classes, lectures, labs, subjects) OR "job" (work shifts, office hours, team meetings, roster, deep work).
2. Extract organization/college/company name into collegeName (or "" if none).
3. For every scheduled slot/shift/class/break across the week:
   - day: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 0=Sun.
   - dayName: Monday..Sunday.
   - name: Subject, Course, Shift title, Meeting, or Task name.
   - startTime & endTime: 24-hour "HH:MM" (convert 12h AM/PM accurately, e.g. 2:30 PM -> "14:30").
   - room: Room/Lab/Hall or Office/Location/Desk (or "").
   - professor: Professor/Instructor or Manager/Team Lead (or "").
   - type: "lecture" | "lab" | "tutorial" | "break" | "shift" | "meeting" | "deep_work".
4. Compute overallStartTime (earliest HH:MM), overallEndTime (latest HH:MM), and activeDays (distinct day numbers with entries).`;

    const responseSchema = {
      type: Type.OBJECT,
      properties: {
        scheduleType: {
          type: Type.STRING,
          description: '"college" for academic/class timetable or "job" for work/shift/office schedule.',
        },
        collegeName: {
          type: Type.STRING,
          description: 'College, university, or company/workplace name if visible.',
        },
        overallStartTime: {
          type: Type.STRING,
          description: 'Earliest start time in HH:MM 24h format (e.g. 09:00).',
        },
        overallEndTime: {
          type: Type.STRING,
          description: 'Latest end time in HH:MM 24h format (e.g. 17:00).',
        },
        activeDays: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: 'Days of week with schedule (1=Mon..6=Sat, 0=Sun).',
        },
        slots: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              day: { type: Type.INTEGER },
              dayName: { type: Type.STRING },
              name: { type: Type.STRING },
              startTime: { type: Type.STRING },
              endTime: { type: Type.STRING },
              room: { type: Type.STRING },
              professor: { type: Type.STRING },
              type: {
                type: Type.STRING,
                description: 'lecture, lab, tutorial, break, shift, meeting, or deep_work.',
              },
            },
            required: ['day', 'name', 'startTime', 'endTime', 'type'],
          },
        },
      },
      required: ['scheduleType', 'slots'],
    };

    const contentsPayload = {
      parts: [
        {
          inlineData: {
            data: cleanBase64,
            mimeType: resolvedMime,
          },
        },
        {
          text: promptText,
        },
      ],
    };

    let response;
    try {
      // Primary Ultra-Fast Turbo Model: gemini-3.1-flash-lite with MINIMAL thinking
      response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: contentsPayload,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
          responseMimeType: 'application/json',
          responseSchema,
        },
      });
    } catch (liteErr) {
      console.warn('Fallback from gemini-3.1-flash-lite to gemini-3.8-flash:', liteErr);
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: contentsPayload,
        config: {
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
          responseMimeType: 'application/json',
          responseSchema,
        },
      });
    }

    const rawText = response.text || '{}';
    let parsedData: any = {};
    try {
      parsedData = JSON.parse(rawText);
    } catch {
      const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      parsedData = JSON.parse(cleaned);
    }

    const detectedType =
      parsedData.scheduleType === 'job' || parsedData.scheduleType === 'work'
        ? 'job'
        : 'college';

    const responsePayload = {
      success: true,
      scheduleType: detectedType,
      collegeName: parsedData.collegeName || '',
      overallStartTime: parsedData.overallStartTime || '09:00',
      overallEndTime: parsedData.overallEndTime || '17:00',
      activeDays:
        Array.isArray(parsedData.activeDays) && parsedData.activeDays.length > 0
          ? parsedData.activeDays
          : [1, 2, 3, 4, 5],
      slots: parsedData.slots || [],
      cached: false,
      durationMs: Date.now() - startTimeMs,
    };

    if (responsePayload.slots.length > 0) {
      if (parseCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = parseCache.keys().next().value;
        if (oldestKey) parseCache.delete(oldestKey);
      }
      parseCache.set(hashKey, responsePayload);
    }

    return res.json(responsePayload);
  } catch (error: any) {
    console.error('Error parsing timetable/schedule with Gemini:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to parse schedule image or PDF.',
    });
  }
});

async function startServer() {
  app.use(express.static(path.resolve(__dirname, 'public')));

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) return next();
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    app.use('*', async (req, res, next) => {
      if (req.method !== 'GET' || req.originalUrl.startsWith('/api/')) {
        return next();
      }
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html; charset=utf-8' }).end(template);
      } catch (err) {
        next(err);
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
