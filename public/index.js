document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const userhashInput = document.getElementById('userhash');
  const tabUpload = document.getElementById('tab-upload');
  const tabYoutube = document.getElementById('tab-youtube');
  const panelUpload = document.getElementById('panel-upload');
  const panelYoutube = document.getElementById('panel-youtube');
  
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const btnBrowse = document.getElementById('btn-browse');
  const fileInfoBadge = document.getElementById('file-info-badge');
  const selectedFileName = document.getElementById('selected-file-name');
  const btnClearFile = document.getElementById('btn-clear-file');
  const youtubeUrlInput = document.getElementById('youtube-url');
  
  const btnCompile = document.getElementById('btn-compile');
  
  const cardProgress = document.getElementById('card-progress');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const compilationPhase = document.getElementById('compilation-phase');
  const compilationPercentage = document.getElementById('compilation-percentage');
  
  const stepDl = document.getElementById('step-dl');
  const stepProbe = document.getElementById('step-probe');
  const stepExtract = document.getElementById('step-extract');
  const stepEncode = document.getElementById('step-encode');
  const stepUploadCat = document.getElementById('step-upload-cat');
  
  const cardResult = document.getElementById('card-result');
  const finalFilename = document.getElementById('final-filename');
  const btnCopyName = document.getElementById('btn-copy-name');
  const statWebmSize = document.getElementById('stat-webm-size');
  const statAudioSize = document.getElementById('stat-audio-size');
  const statTotalSize = document.getElementById('stat-total-size');
  
  const previewVideo = document.getElementById('preview-video');
  const btnPlay = document.getElementById('btn-play');
  const btnMute = document.getElementById('btn-mute');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const unmuteIcon = document.getElementById('unmute-icon');
  const muteIcon = document.getElementById('mute-icon');
  const playerTimeline = document.getElementById('player-timeline');
  const timeDisplay = document.getElementById('time-display');
  
  const btnDownload = document.getElementById('btn-download');
  const emptyState = document.getElementById('empty-state');
  
  const trimEnable = document.getElementById('trim-enable');
  const trimInputsContainer = document.getElementById('trim-inputs-container');
  const trimStartInput = document.getElementById('trim-start');
  const trimEndInput = document.getElementById('trim-end');


  // State Variables
  let currentSourceTab = 'upload'; // 'upload' or 'youtube'
  let selectedFile = null;
  let serverUploadedFilename = null;
  let activeJobId = null;
  let pollInterval = null;
  let audioStream = new Audio(); // Dual-sync player audio element
  let resultData = null;

  // 1. Catbox Userhash persistence
  const savedUserhash = localStorage.getItem('catbox_userhash');
  if (savedUserhash) {
    userhashInput.value = savedUserhash;
  }

  userhashInput.addEventListener('input', () => {
    localStorage.setItem('catbox_userhash', userhashInput.value.trim());
    validateInputs();
  });

  // Toggle trim inputs visibility
  trimEnable.addEventListener('change', () => {
    if (trimEnable.checked) {
      trimInputsContainer.style.display = 'grid';
    } else {
      trimInputsContainer.style.display = 'none';
      trimStartInput.value = '';
      trimEndInput.value = '';
    }
  });


  // 2. Tab switching
  tabUpload.addEventListener('click', () => {
    currentSourceTab = 'upload';
    tabUpload.classList.add('active');
    tabYoutube.classList.remove('active');
    panelUpload.classList.add('active');
    panelYoutube.classList.remove('active');
    validateInputs();
  });

  tabYoutube.addEventListener('click', () => {
    currentSourceTab = 'youtube';
    tabYoutube.classList.add('active');
    tabUpload.classList.remove('active');
    panelYoutube.classList.add('active');
    panelUpload.classList.remove('active');
    validateInputs();
  });

  // 3. File upload dropzone logic
  btnBrowse.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelection(e.target.files[0]);
    }
  });

  btnClearFile.addEventListener('click', (e) => {
    e.stopPropagation();
    resetFileSelection();
  });

  function handleFileSelection(file) {
    if (!file.type.startsWith('video/')) {
      showToast('Please select a valid video file.', 'error');
      return;
    }
    selectedFile = file;
    selectedFileName.textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
    fileInfoBadge.style.display = 'flex';
    dropzone.style.display = 'none';
    validateInputs();
  }

  function resetFileSelection() {
    selectedFile = null;
    fileInput.value = '';
    serverUploadedFilename = null;
    fileInfoBadge.style.display = 'none';
    dropzone.style.display = 'flex';
    validateInputs();
  }

  youtubeUrlInput.addEventListener('input', () => {
    validateInputs();
  });

  // 4. Inputs validation
  function validateInputs() {
    const hasHash = userhashInput.value.trim().length > 0;
    let hasSource = false;
    
    if (currentSourceTab === 'upload') {
      hasSource = selectedFile !== null;
    } else {
      const url = youtubeUrlInput.value.trim();
      hasSource = url.length > 0 && (url.includes('youtube.com') || url.includes('youtu.be'));
    }
    
    btnCompile.disabled = !(hasHash && hasSource);
  }

  // 5. Trigger Compilation
  btnCompile.addEventListener('click', async () => {
    const userhash = userhashInput.value.trim();
    if (!userhash) {
      showToast('Catbox Userhash is required.', 'error');
      return;
    }

    // Reset view states
    cardResult.style.display = 'none';
    emptyState.style.display = 'none';
    cardProgress.style.display = 'block';
    resetPlayer();

    // Reset step UI
    resetStepsUI();

    try {
      if (currentSourceTab === 'upload') {
        compilationPhase.textContent = 'Uploading video file to server...';
        compilationPercentage.textContent = '0%';
        progressBarFill.style.width = '0%';
        
        // Step 1: Upload local video via /api/upload
        const formData = new FormData();
        formData.append('file', selectedFile);
        
        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          body: formData
        });
        
        if (!uploadResponse.ok) {
          throw new Error('Failed to upload video to backend.');
        }
        
        const uploadData = await uploadResponse.json();
        serverUploadedFilename = uploadData.filename;
      }

      // Step 2: Trigger compilation
      compilationPhase.textContent = 'Queueing compilation job...';
      const compilePayload = {
        userhash,
        filename: serverUploadedFilename,
        youtubeUrl: currentSourceTab === 'youtube' ? youtubeUrlInput.value.trim() : null
      };

      if (trimEnable.checked) {
        compilePayload.startTime = trimStartInput.value.trim() || null;
        compilePayload.endTime = trimEndInput.value.trim() || null;
      }


      const compileResponse = await fetch('/api/create-soundpost', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(compilePayload)
      });

      if (!compileResponse.ok) {
        const errorData = await compileResponse.json();
        throw new Error(errorData.error || 'Failed to start compilation job.');
      }

      const compileData = await compileResponse.json();
      activeJobId = compileData.jobId;

      // Start status polling
      startPolling(activeJobId);

    } catch (err) {
      showToast(err.message, 'error');
      cardProgress.style.display = 'none';
      emptyState.style.display = 'block';
    }
  });

  // 6. Polling Job Status
  function startPolling(jobId) {
    if (pollInterval) clearInterval(pollInterval);
    
    pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}/status`);
        if (!response.ok) throw new Error('Failed to fetch job status.');
        
        const job = await response.json();
        updateProgressUI(job);

        if (job.status === 'completed') {
          clearInterval(pollInterval);
          showToast('Soundpost compiled successfully!', 'success');
          displayResult(job.result);
        } else if (job.status === 'failed') {
          clearInterval(pollInterval);
          showToast(job.error || 'Compilation failed.', 'error');
          cardProgress.style.display = 'none';
          emptyState.style.display = 'block';
        }
      } catch (err) {
        clearInterval(pollInterval);
        showToast('Polling error: ' + err.message, 'error');
        cardProgress.style.display = 'none';
        emptyState.style.display = 'block';
      }
    }, 1000);
  }

  function resetStepsUI() {
    [stepDl, stepProbe, stepExtract, stepEncode, stepUploadCat].forEach(step => {
      step.className = 'step-item';
    });
  }

  function updateProgressUI(job) {
    compilationPhase.textContent = job.phase;
    compilationPercentage.textContent = `${job.progress}%`;
    progressBarFill.style.width = `${job.progress}%`;

    // Map step items dynamically based on current phase and progress
    resetStepsUI();

    const isYt = job.type === 'youtube';

    // Download step (YouTube only)
    if (isYt) {
      stepDl.style.display = 'flex';
      if (job.phase.startsWith('Downloading')) {
        stepDl.classList.add('active');
      } else if (job.progress > 10) {
        stepDl.classList.add('completed');
      }
    } else {
      stepDl.style.display = 'none';
    }

    // Analyze step
    if (job.phase.startsWith('Analyzing')) {
      stepProbe.classList.add('active');
    } else if (job.progress > 15) {
      stepProbe.classList.add('completed');
    }

    // Extract step
    if (job.phase.startsWith('Extracting')) {
      stepExtract.classList.add('active');
    } else if (job.progress > 30) {
      stepExtract.classList.add('completed');
    }

    // Encode step
    if (job.phase.startsWith('Encoding') || job.phase.startsWith('Re-encoding')) {
      stepEncode.classList.add('active');
    } else if (job.progress > 85) {
      stepEncode.classList.add('completed');
    }

    // Upload step
    if (job.phase.startsWith('Uploading')) {
      stepUploadCat.classList.add('active');
    } else if (job.status === 'completed') {
      stepUploadCat.classList.add('completed');
    }
  }

  // 7. Display Compilation Results
  function displayResult(result) {
    resultData = result;
    cardProgress.style.display = 'none';
    cardResult.style.display = 'block';

    finalFilename.textContent = result.soundpostName;
    
    const webmSizeKB = result.webmSize / 1024;
    const audioSizeKB = result.audioSize / 1024;
    const totalSizeKB = (result.webmSize + result.audioSize) / 1024;

    statWebmSize.textContent = `${webmSizeKB.toFixed(1)} KB`;
    statAudioSize.textContent = `${audioSizeKB.toFixed(1)} KB`;
    statTotalSize.textContent = `${totalSizeKB.toFixed(1)} KB`;

    // Configure sync player
    setupSyncPlayer(result.videoFilename, result.catboxUrl);
  }

  // 8. Dual-Stream Sync Player
  function setupSyncPlayer(videoFilename, catboxUrl) {
    resetPlayer();

    // Source mapping
    previewVideo.src = `/api/download/${videoFilename}`;
    audioStream = new Audio(catboxUrl);
    audioStream.preload = 'auto';

    let isSeeking = false;
    audioStream.addEventListener('seeking', () => { isSeeking = true; });
    audioStream.addEventListener('seeked', () => { isSeeking = false; });

    // Synchronize play state
    previewVideo.addEventListener('play', () => {
      audioStream.play().catch(e => console.warn('Audio play failed:', e));
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    });

    previewVideo.addEventListener('pause', () => {
      audioStream.pause();
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    });

    // Mute/volume sync
    previewVideo.addEventListener('volumechange', () => {
      audioStream.volume = previewVideo.volume;
      audioStream.muted = previewVideo.muted;
    });

    // Load metadata to configure duration
    previewVideo.addEventListener('loadedmetadata', () => {
      playerTimeline.max = Math.floor(previewVideo.duration);
      updateTimeDisplay(0, previewVideo.duration);
    });

    // Periodically update timeline and display time
    previewVideo.addEventListener('timeupdate', () => {
      if (!playerTimeline.classList.contains('seeking')) {
        playerTimeline.value = Math.floor(previewVideo.currentTime);
      }
      updateTimeDisplay(previewVideo.currentTime, previewVideo.duration);
    });

    // Keep streams in tight synchronization
    const syncChecker = setInterval(() => {
      if (previewVideo.paused) return;

      // Sync play/pause states if they drifted
      if (!previewVideo.paused && audioStream.paused && !isSeeking && !audioStream.seeking) {
        audioStream.play().catch(e => console.warn(e));
      }
      
      if (isSeeking || audioStream.seeking) return;

      const diff = Math.abs(previewVideo.currentTime - audioStream.currentTime);
      // If drift is larger than 250ms, snap audio back to video position
      if (diff > 0.25) {
        console.log(`Syncing drift of ${diff.toFixed(3)}s`);
        isSeeking = true;
        audioStream.currentTime = previewVideo.currentTime;
      }
    }, 250);

    // Save timer pointer on video element so we can clean it up
    previewVideo.dataset.syncTimerId = syncChecker;

    // Timeline seeking logic
    playerTimeline.addEventListener('input', () => {
      playerTimeline.classList.add('seeking');
    });

    playerTimeline.addEventListener('change', () => {
      playerTimeline.classList.remove('seeking');
      const targetTime = parseFloat(playerTimeline.value);
      isSeeking = true;
      previewVideo.currentTime = targetTime;
      audioStream.currentTime = targetTime;
    });
  }

  function resetPlayer() {
    previewVideo.pause();
    previewVideo.src = '';
    
    // Clean sync timer
    if (previewVideo.dataset.syncTimerId) {
      clearInterval(parseInt(previewVideo.dataset.syncTimerId, 10));
      delete previewVideo.dataset.syncTimerId;
    }

    if (audioStream) {
      audioStream.pause();
      audioStream.src = '';
    }

    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
    playerTimeline.value = 0;
    timeDisplay.textContent = '0:00 / 0:00';
  }

  function updateTimeDisplay(current, duration) {
    if (isNaN(duration)) return;
    const formatTime = (secs) => {
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60).toString().padStart(2, '0');
      return `${m}:${s}`;
    };
    timeDisplay.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
  }

  // Play/Pause button trigger
  btnPlay.addEventListener('click', () => {
    if (previewVideo.paused) {
      previewVideo.play();
    } else {
      previewVideo.pause();
    }
  });

  // Mute button trigger
  btnMute.addEventListener('click', () => {
    const isMuted = !previewVideo.muted;
    previewVideo.muted = isMuted;
    audioStream.muted = isMuted;
    
    if (isMuted) {
      unmuteIcon.style.display = 'none';
      muteIcon.style.display = 'block';
    } else {
      unmuteIcon.style.display = 'block';
      muteIcon.style.display = 'none';
    }
  });

  // 9. Download handler
  btnDownload.addEventListener('click', () => {
    if (!resultData) return;
    
    const downloadUrl = `/api/download/${resultData.videoFilename}?name=${encodeURIComponent(resultData.soundpostName)}`;
    
    // Create temporary download link and trigger it
    const a = document.createElement('a');
    a.href = downloadUrl;
    // We do not set a.download here. Letting the server's Content-Disposition header
    // dictate the exact literal filename prevents browser URL-decoding bugs.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  // Copy Filename handler
  btnCopyName.addEventListener('click', () => {
    navigator.clipboard.writeText(finalFilename.textContent)
      .then(() => {
        showToast('Filename copied to clipboard!', 'success');
      })
      .catch(() => {
        showToast('Failed to copy filename.', 'error');
      });
  });

  // Helper Toast Notifications
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${type === 'success' ? '#10b981' : '#fff'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    } else {
      iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00f0ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
    }

    toast.innerHTML = `
      ${iconSvg}
      <span class="toast-message">${message}</span>
    `;
    
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px) scale(0.9)';
      setTimeout(() => {
        container.removeChild(toast);
      }, 350);
    }, 4000);
  }
});
