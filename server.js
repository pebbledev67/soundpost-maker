const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;


const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Setup folders
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

// Serve public directory
app.use(express.static(PUBLIC_DIR));

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const sanitized = basename.replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${sanitized}-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Job store (in-memory)
const jobs = {};

// Helper: Get media duration using ffprobe
function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    exec(`"${ffprobePath}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`ffprobe failed: ${stderr || err.message}`));
      }
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration)) {
        return reject(new Error('Invalid duration returned by ffprobe'));
      }
      resolve(duration);
    });
  });
}

// Helper: Check if file has audio stream
function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    exec(`"${ffprobePath}" -v error -select_streams a -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${filePath}"`, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Helper: Parse FFmpeg stderr for progress
function parseFFmpegProgress(ffmpegProcess, totalDuration, onProgress) {
  ffmpegProcess.stderr.on('data', (data) => {
    const str = data.toString();
    const match = str.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    if (match) {
      const hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const seconds = parseFloat(match[3] + '.' + match[4]);
      const currentTime = hours * 3600 + minutes * 60 + seconds;
      const progress = Math.min(Math.round((currentTime / totalDuration) * 100), 99);
      onProgress(progress);
    }
  });
}

// Helper: Parse timestamp strings (e.g. ss, mm:ss, hh:mm:ss) to seconds
function parseTimestamp(str) {
  if (!str || typeof str !== 'string' || !str.trim()) return null;
  const clean = str.trim();
  const parts = clean.split(':').map(Number);
  
  if (parts.some(isNaN)) return null;
  
  if (parts.length === 3) {
    // hh:mm:ss
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // mm:ss
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 1) {
    // ss
    return parts[0];
  }
  return null;
}

// Helper: Download video from YouTube using yt-dlp, optionally trimming
function downloadYoutubeVideo(url, outputPath, job, startSec, endSec) {
  return new Promise((resolve, reject) => {
    const escapedUrl = url.replace(/"/g, '\\"');
    exec(`yt-dlp --get-title "${escapedUrl}"`, (err, stdout) => {
      let originalTitle = 'youtube_video';
      if (!err && stdout.trim()) {
        originalTitle = stdout.trim();
      }
      job.originalTitle = originalTitle;

      // Construct yt-dlp arguments
      let sectionsArg = '';
      if (startSec !== null || endSec !== null) {
        const start = startSec !== null ? startSec : 0;
        const end = endSec !== null ? endSec : 'inf';
        sectionsArg = `--download-sections "*${start}-${end}" `;
      }

      // Download best quality mp4 or mkv
      const command = `yt-dlp ${sectionsArg}-f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]" -o "${outputPath}" "${escapedUrl}"`;
      console.log(`Executing YouTube download: ${command}`);
      const proc = exec(command);

      proc.stdout.on('data', (data) => {
        const match = data.toString().match(/(\d+\.\d+)%/);
        if (match) {
          const percent = parseFloat(match[1]);
          // Map to 0-100% of the download phase
          job.progress = Math.min(Math.round(percent), 99);
          job.phase = `Downloading video (${job.progress}%)`;
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            // Find if yt-dlp appended any extension and rename it to raw outputPath
            const parentDir = path.dirname(outputPath);
            const baseName = path.basename(outputPath);
            const files = fs.readdirSync(parentDir);
            const matchedFile = files.find(f => f.startsWith(baseName));
            if (matchedFile && matchedFile !== baseName) {
              fs.renameSync(path.join(parentDir, matchedFile), outputPath);
            }
            resolve();
          } catch (renameErr) {
            reject(renameErr);
          }
        } else {
          reject(new Error(`yt-dlp failed with exit code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  });
}

// Upload file to Catbox.moe
async function uploadToCatbox(filePath, userhash) {
  const stats = fs.statSync(filePath);
  
  // Use Node's global FormData
  const formData = new FormData();
  formData.append('reqtype', 'fileupload');
  formData.append('userhash', userhash);
  
  // Build a File/Blob so fetch works correctly
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  
  // Guess the mime type
  const fileBlob = new Blob([fileBuffer], { type: 'audio/aac' });
  formData.append('fileToUpload', fileBlob, fileName);

  console.log(`Uploading ${fileName} (${(stats.size / 1024).toFixed(1)} KB) to Catbox.moe...`);
  const response = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    throw new Error(`Catbox HTTP error! Status: ${response.status}`);
  }

  const responseText = await response.text();
  const trimmed = responseText.trim();
  if (!trimmed.startsWith('http')) {
    throw new Error(`Catbox upload failed: ${trimmed}`);
  }

  return trimmed;
}

// Endpoint: File upload
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    path: req.file.path,
    size: req.file.size
  });
});

// Endpoint: Create Soundpost
app.post('/api/create-soundpost', async (req, res) => {
  const { filename, youtubeUrl, userhash, startTime, endTime } = req.body;

  if (!userhash || typeof userhash !== 'string' || !userhash.trim()) {
    return res.status(400).json({ error: 'Catbox Userhash is required' });
  }

  if (!filename && !youtubeUrl) {
    return res.status(400).json({ error: 'Either a video file or a YouTube link must be provided' });
  }

  const startSec = parseTimestamp(startTime);
  const endSec = parseTimestamp(endTime);

  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    status: 'processing',
    phase: 'Initializing...',
    progress: 0,
    type: youtubeUrl ? 'youtube' : 'upload',
    originalTitle: filename ? path.basename(filename, path.extname(filename)) : 'soundpost'
  };

  // Return job ID immediately to allow polling
  res.json({ jobId });

  // Process in the background
  (async () => {
    let inputPath = '';
    const tempDownloadPath = path.join(UPLOADS_DIR, `soundpost-download-${jobId}`);

    try {
      // 1. YouTube download phase if applicable
      if (youtubeUrl) {
        jobs[jobId].phase = 'Downloading video from YouTube...';
        await downloadYoutubeVideo(youtubeUrl, tempDownloadPath, jobs[jobId], startSec, endSec);
        inputPath = tempDownloadPath;
      } else {
        inputPath = path.join(UPLOADS_DIR, filename);
        if (!fs.existsSync(inputPath)) {
          throw new Error('Uploaded video file not found');
        }
      }

      jobs[jobId].progress = 10;
      jobs[jobId].phase = 'Analyzing video metadata...';

      // 2. Validate media
      const hasAudio = await hasAudioStream(inputPath);
      if (!hasAudio) {
        throw new Error('The video file does not contain an audio track. 4chan soundposts require audio.');
      }

      let duration = 0;
      let isLocalTrim = false;
      let trimStart = 0;

      if (youtubeUrl) {
        // If YouTube, the downloaded file is already trimmed
        duration = await getDuration(inputPath);
        console.log(`Downloaded YouTube video duration: ${duration.toFixed(2)}s`);
      } else {
        const originalDuration = await getDuration(inputPath);
        console.log(`Uploaded video duration: ${originalDuration.toFixed(2)}s`);
        
        if (startSec !== null || endSec !== null) {
          isLocalTrim = true;
          trimStart = startSec !== null ? startSec : 0;
          const trimEnd = endSec !== null ? endSec : originalDuration;
          
          if (trimStart < 0) trimStart = 0;
          let calculatedEnd = trimEnd;
          if (calculatedEnd > originalDuration) calculatedEnd = originalDuration;
          
          duration = calculatedEnd - trimStart;
          if (duration <= 0) {
            throw new Error('Invalid trim range: End time must be greater than start time.');
          }
          console.log(`Trimming uploaded video to portion: ${trimStart.toFixed(2)}s - ${calculatedEnd.toFixed(2)}s (Duration: ${duration.toFixed(2)}s)`);
        } else {
          duration = originalDuration;
        }
      }

      if (duration > 300) {
        throw new Error('Video duration is too long (over 5 minutes) to fit within the 4MB limit.');
      }

      jobs[jobId].progress = 15;
      jobs[jobId].phase = 'Extracting audio track...';

      // 3. Determine audio bitrate and extract
      let audioBitrate = 128;
      if (duration > 240) audioBitrate = 48;
      else if (duration > 120) audioBitrate = 64;
      else if (duration > 60) audioBitrate = 96;

      const audioOutputPath = path.join(OUTPUTS_DIR, `soundpost-audio-${jobId}.aac`);
      
      const audioArgs = [ '-y' ];
      if (isLocalTrim) {
        audioArgs.push('-ss', trimStart.toString(), '-t', duration.toString());
      }
      audioArgs.push(
        '-i', inputPath,
        '-vn',
        '-c:a', 'aac',
        '-b:a', `${audioBitrate}k`,
        audioOutputPath
      );

      const audioFfmpeg = spawn(ffmpegPath, audioArgs);
      await new Promise((resolve, reject) => {
        parseFFmpegProgress(audioFfmpeg, duration, (p) => {
          // Map to 15% - 30% progress
          jobs[jobId].progress = 15 + Math.round(p * 0.15);
          jobs[jobId].phase = `Extracting audio (${jobs[jobId].progress}%)`;
        });
        audioFfmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg audio extraction failed with code ${code}`));
        });
        audioFfmpeg.on('error', reject);
      });

      const audioStats = fs.statSync(audioOutputPath);
      const audioSizeBytes = audioStats.size;
      console.log(`Extracted audio size: ${(audioSizeBytes / 1024).toFixed(1)} KB`);

      jobs[jobId].progress = 30;
      jobs[jobId].phase = 'Calculating video compression parameters...';

      // 4. Calculate target video size & bitrate
      // Target limit: 3.85MB (safe buffer under 4MB). Audio size is hosted on Catbox, so it doesn't count against 4chan's limit.
      const targetVideoSize = 3.85 * 1024 * 1024;

      let videoBitrateBps = Math.floor((targetVideoSize * 8) / duration);
      console.log(`Calculated video bitrate: ${(videoBitrateBps / 1000).toFixed(1)} kbps`);

      if (videoBitrateBps < 80 * 1000) {
        throw new Error(`Calculated video bitrate is too low (${(videoBitrateBps / 1000).toFixed(1)} kbps). Video is too long to compress under 4MB with acceptable quality.`);
      }

      // Cap video bitrate at 2.0 Mbps
      if (videoBitrateBps > 2000 * 1000) {
        videoBitrateBps = 2000 * 1000;
      }

      // Select scaling filter based on bitrate to preserve visual quality, capping at 1080p maximum dimension for 4chan compliance
      let maxDim = 1080;
      if (videoBitrateBps < 150 * 1000) maxDim = 240;
      else if (videoBitrateBps < 350 * 1000) maxDim = 360;
      else if (videoBitrateBps < 700 * 1000) maxDim = 480;
      else if (videoBitrateBps < 1200 * 1000) maxDim = 720;

      // Fit the video within a bounding box of maxDim x maxDim while preserving aspect ratio
      let scaleFilter = `scale='if(gt(iw,ih),min(${maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${maxDim},ih))':force_original_aspect_ratio=decrease`;

      const videoOutputPath = path.join(OUTPUTS_DIR, `soundpost-video-${jobId}.webm`);

      const encodeWebm = async (bitrate, crf = 32) => {
        const videoArgs = [ '-y' ];
        if (isLocalTrim) {
          videoArgs.push('-ss', trimStart.toString(), '-t', duration.toString());
        }
        videoArgs.push('-i', inputPath);

        if (scaleFilter) {
          videoArgs.push('-vf', scaleFilter);
        }

        videoArgs.push(
          '-an',
          '-c:v', 'libvpx-vp9',
          '-b:v', `${bitrate}`,
          '-maxrate', `${Math.floor(bitrate * 1.15)}`,
          '-bufsize', `${Math.floor(bitrate * 2.5)}`,
          '-crf', crf.toString(),
          '-speed', '4',
          '-deadline', 'good',
          videoOutputPath
        );

        const videoFfmpeg = spawn(ffmpegPath, videoArgs);
        await new Promise((resolve, reject) => {
          parseFFmpegProgress(videoFfmpeg, duration, (p) => {
            // Map to 30% - 85% progress
            jobs[jobId].progress = 30 + Math.round(p * 0.55);
            jobs[jobId].phase = `Encoding WebM (${jobs[jobId].progress}%)`;
          });
          videoFfmpeg.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg WebM encoding failed with code ${code}`));
          });
          videoFfmpeg.on('error', reject);
        });
      };

      // 5. Run initial WebM encode
      jobs[jobId].phase = 'Encoding WebM (0%)...';
      await encodeWebm(videoBitrateBps, 32);

      let videoStats = fs.statSync(videoOutputPath);
      let totalSize = videoStats.size;
      console.log(`Initial WebM Size: ${(videoStats.size / 1024).toFixed(1)} KB`);

      // 6. Size feedback loop
      let attempts = 0;
      let crfValue = 32;

      while (totalSize > 3.98 * 1024 * 1024 && attempts < 4) {
        attempts++;
        console.warn(`Overshot 4MB budget (Size: ${(totalSize / 1024).toFixed(1)} KB). Attempt ${attempts} to adjust parameters...`);
        
        if (attempts === 1) {
          // Attempt 1: Keep same resolution, lower bitrate by 25%, increase CRF to 36
          videoBitrateBps = Math.floor(videoBitrateBps * 0.75);
          crfValue = 36;
          jobs[jobId].phase = 'Re-encoding (reducing bitrate & increasing compression)...';
        } else if (attempts === 2) {
          // Attempt 2: Drop resolution to 720p, set CRF to 35, lower bitrate by 20%
          maxDim = maxDim > 720 ? 720 : maxDim;
          scaleFilter = `scale='if(gt(iw,ih),min(${maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${maxDim},ih))':force_original_aspect_ratio=decrease`;
          crfValue = 35;
          videoBitrateBps = Math.floor(videoBitrateBps * 0.8);
          jobs[jobId].phase = 'Re-encoding (downscaling to 720p)...';
        } else if (attempts === 3) {
          // Attempt 3: Drop resolution to 480p, set CRF to 38, lower bitrate by 20%
          maxDim = maxDim > 480 ? 480 : maxDim;
          scaleFilter = `scale='if(gt(iw,ih),min(${maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${maxDim},ih))':force_original_aspect_ratio=decrease`;
          crfValue = 38;
          videoBitrateBps = Math.floor(videoBitrateBps * 0.8);
          jobs[jobId].phase = 'Re-encoding (downscaling to 480p)...';
        } else if (attempts === 4) {
          // Attempt 4: Drop resolution to 360p, set CRF to 44, lower bitrate by 30%
          maxDim = 360;
          scaleFilter = `scale='if(gt(iw,ih),min(${maxDim},iw),-2)':'if(gt(iw,ih),-2,min(${maxDim},ih))':force_original_aspect_ratio=decrease`;
          crfValue = 44;
          videoBitrateBps = Math.floor(videoBitrateBps * 0.7);
          jobs[jobId].phase = 'Re-encoding (downscaling to 360p & applying maximum compression)...';
        }
        
        console.log(`Retrying encoding with bitrate: ${(videoBitrateBps / 1000).toFixed(1)} kbps, maxDim: ${maxDim}, CRF: ${crfValue}`);
        await encodeWebm(videoBitrateBps, crfValue);
        
        videoStats = fs.statSync(videoOutputPath);
        totalSize = videoStats.size;
        console.log(`Attempt ${attempts} WebM Size: ${(videoStats.size / 1024).toFixed(1)} KB`);
      }

      if (totalSize > 4.02 * 1024 * 1024) {
        throw new Error('Unable to compress video under the strict 4MB limit with acceptable quality. Try a shorter video.');
      }

      jobs[jobId].progress = 85;
      jobs[jobId].phase = 'Uploading audio to Catbox.moe...';

      // 7. Upload audio to Catbox.moe
      const catboxUrl = await uploadToCatbox(audioOutputPath, userhash);
      console.log(`Catbox URL: ${catboxUrl}`);

      jobs[jobId].progress = 98;
      jobs[jobId].phase = 'Finalizing soundpost file...';

      // 8. Construct formatted filename
      const sanitizedTitle = jobs[jobId].originalTitle
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 40); // Cap title length
      
      const encodedUrl = encodeURIComponent(catboxUrl);
      const soundpostName = `${sanitizedTitle}[sound=${encodedUrl}].webm`;

      jobs[jobId].status = 'completed';
      jobs[jobId].progress = 100;
      jobs[jobId].phase = 'Complete';
      jobs[jobId].result = {
        videoFilename: `soundpost-video-${jobId}.webm`,
        catboxUrl,
        soundpostName,
        webmSize: videoStats.size,
        audioSize: audioSizeBytes
      };

    } catch (err) {
      console.error(`Soundpost job ${jobId} failed:`, err.message);
      jobs[jobId].status = 'failed';
      jobs[jobId].error = err.message;
      jobs[jobId].phase = 'Failed';
    } finally {
      // Clean up temporary download file if it exists
      if (fs.existsSync(tempDownloadPath)) {
        try { fs.unlinkSync(tempDownloadPath); } catch (e) {}
      }
    }
  })();
});

// Endpoint: Check Job Status
app.get('/api/jobs/:id/status', (req, res) => {
  const { id } = req.params;
  const job = jobs[id];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// Endpoint: Download WebM File
app.get('/api/download/:filename', (req, res) => {
  const { filename } = req.params;
  const downloadName = req.query.name;

  // Prevent directory traversal
  const cleanFilename = path.basename(filename);
  const filePath = path.join(OUTPUTS_DIR, cleanFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }

  let suggestedName = 'soundpost.webm';
  if (downloadName) {
    // Replace backward and forward slashes to prevent directory traversal
    suggestedName = downloadName.replace(/[\/\\]/g, '_');
  }
  
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Disposition', `attachment; filename="${suggestedName}"`);
  res.sendFile(filePath);
});

// Cleanup outputs and uploads directory on exit to free HDD space
const cleanDirectories = () => {
  console.log('Cleaning up files...');
  [UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => {
    try {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              fs.unlinkSync(filePath);
            }
          } catch (fileErr) {
            console.warn(`Could not delete file ${file}:`, fileErr.message);
          }
        }
      }
    } catch (err) {
      console.error(`Failed to clean directory ${dir}:`, err.message);
    }
  });
  console.log('Cleanup complete.');
};

process.on('exit', cleanDirectories);
process.on('SIGINT', () => { cleanDirectories(); process.exit(0); });
process.on('SIGTERM', () => { cleanDirectories(); process.exit(0); });

// Start Server
app.listen(PORT, () => {
  console.log(`Soundpost Maker server starting on port ${PORT}...`);
  // Purge any temporary files from previous sessions on startup
  cleanDirectories();
  console.log(`Ready for connections! Open http://localhost:${PORT} in your browser.`);
});
