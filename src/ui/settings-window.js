document.addEventListener('DOMContentLoaded', () => {
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperDeviceSelect = document.getElementById('whisperDevice');
    const whisperCaptureModeSelect = document.getElementById('whisperCaptureMode');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const geminiKeyInput = document.getElementById('geminiKey');
    const gatewayKeyInput = document.getElementById('gatewayKey');
    const gatewayModelsInput = document.getElementById('gatewayModels');
    const gatewayEffortSelect = document.getElementById('gatewayEffort');
    const gatewayDiscoveryInput = document.getElementById('gatewayDiscovery');
    const gatewayFreeOnlyInput = document.getElementById('gatewayFreeOnly');
    const autoScreenInput = document.getElementById('autoScreen');
    const gatewayBaseUrlInput = document.getElementById('gatewayBaseUrl');
    const gatewayAuthSelect = document.getElementById('gatewayAuth');
    const gatewayFormatSelect = document.getElementById('gatewayFormat');
    const gwAutoPickBtn = document.getElementById('gwAutoPickBtn');
    const gwDiscoverBtn = document.getElementById('gwDiscoverBtn');
    const gwTestModelsBtn = document.getElementById('gwTestModelsBtn');
    const gwTestApiBtn = document.getElementById('gwTestApiBtn');
    const gwModelStatus = document.getElementById('gwModelStatus');
    const gwApiStatus = document.getElementById('gwApiStatus');
    const gwDiscoverBox = document.getElementById('gwDiscoverBox');
    const gwDiscoverList = document.getElementById('gwDiscoverList');
    const gwDiscoverFilter = document.getElementById('gwDiscoverFilter');
    const gwTestResults = document.getElementById('gwTestResults');
    const curlInput = document.getElementById('curlInput');
    const curlApplyBtn = document.getElementById('curlApplyBtn');
    const curlStatus = document.getElementById('curlStatus');
    const llmProviderSelect = document.getElementById('llmProvider');
    const llmRoutingSelect = document.getElementById('llmRouting');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const iconGrid = document.getElementById('iconGrid');

    // The coding language only applies to DSA mode, so lock it in Interview mode.
    const codingLanguageItem = document.getElementById('codingLanguageItem');
    const codingLanguageDesc = document.getElementById('codingLanguageDesc');
    const syncCodingLanguageState = () => {
        const isDsa = !activeSkillSelect || activeSkillSelect.value === 'dsa';
        if (codingLanguageSelect) codingLanguageSelect.disabled = !isDsa;
        if (codingLanguageItem) codingLanguageItem.classList.toggle('is-disabled', !isDsa);
        if (codingLanguageDesc) {
            codingLanguageDesc.textContent = isDsa
                ? 'Language used for code in answers'
                : 'Only used in DSA mode. Switch Active Skill to DSA to change it.';
        }
    };

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }

                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }

                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);

            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureKeyInput) azureKeyInput.value = settings.azureKey || '';
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperDeviceSelect) whisperDeviceSelect.value = settings.whisperDevice || 'auto';
        if (whisperCaptureModeSelect) whisperCaptureModeSelect.value = settings.whisperCaptureMode || 'vad';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        if (geminiKeyInput) geminiKeyInput.value = settings.geminiKey || '';
        if (gatewayKeyInput) gatewayKeyInput.value = settings.gatewayKey || '';
        if (gatewayModelsInput) gatewayModelsInput.value = (settings.gatewayModels || '').split(',').filter(Boolean).join('\n');
        if (gatewayEffortSelect) gatewayEffortSelect.value = settings.gatewayEffort || '';
        if (gatewayDiscoveryInput) gatewayDiscoveryInput.checked = !!settings.gatewayDiscovery;
        if (gatewayFreeOnlyInput) gatewayFreeOnlyInput.checked = !!settings.gatewayFreeOnly;
        if (autoScreenInput) autoScreenInput.checked = settings.autoScreen !== false;
        if (gatewayBaseUrlInput) gatewayBaseUrlInput.value = settings.gatewayBaseUrl || '';
        if (gatewayAuthSelect) gatewayAuthSelect.value = settings.gatewayAuth || '';
        if (gatewayFormatSelect) gatewayFormatSelect.value = settings.gatewayFormat || '';
        if (llmProviderSelect) llmProviderSelect.value = settings.llmProvider || 'gemini';
        if (llmRoutingSelect) llmRoutingSelect.value = settings.llmRouting || 'auto';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;
        syncCodingLanguageState();

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        updateSpeechFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((event, data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperDeviceSelect) settings.whisperDevice = whisperDeviceSelect.value;
        if (whisperCaptureModeSelect) settings.whisperCaptureMode = whisperCaptureModeSelect.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (gatewayKeyInput) settings.gatewayKey = gatewayKeyInput.value;
        if (gatewayModelsInput) settings.gatewayModels = gatewayModelsInput.value.trim();
        if (gatewayEffortSelect) settings.gatewayEffort = gatewayEffortSelect.value;
        if (gatewayDiscoveryInput) settings.gatewayDiscovery = gatewayDiscoveryInput.checked;
        if (gatewayFreeOnlyInput) settings.gatewayFreeOnly = gatewayFreeOnlyInput.checked;
        if (autoScreenInput) settings.autoScreen = autoScreenInput.checked;
        if (gatewayBaseUrlInput) settings.gatewayBaseUrl = gatewayBaseUrlInput.value.trim();
        if (gatewayAuthSelect) settings.gatewayAuth = gatewayAuthSelect.value;
        if (gatewayFormatSelect) settings.gatewayFormat = gatewayFormatSelect.value;
        if (llmProviderSelect) settings.llmProvider = llmProviderSelect.value;
        if (llmRoutingSelect) settings.llmRouting = llmRoutingSelect.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;

        window.api.send('save-settings', settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperDeviceSelect,
            whisperCaptureModeSelect, whisperSegmentMsInput].forEach(input => {
            if (input) input.disabled = provider !== 'whisper';
        });
    };

    // Fill the custom-provider fields from a pasted curl command.
    if (curlApplyBtn && curlInput) {
        curlApplyBtn.addEventListener('click', () => {
            const r = window.CurlParser.parseCurl(curlInput.value);
            if (!r.ok) {
                curlStatus.textContent = r.error;
                return;
            }
            if (gatewayBaseUrlInput) gatewayBaseUrlInput.value = /(^|\/\/)api\.anthropic\.com/.test(r.baseUrl) ? '' : r.baseUrl;
            if (gatewayAuthSelect) gatewayAuthSelect.value = r.auth || '';
            if (gatewayFormatSelect) gatewayFormatSelect.value = r.format || '';
            if (r.apiKey && gatewayKeyInput) gatewayKeyInput.value = r.apiKey;
            if (r.model && gatewayModelsInput) {
                const rest = gatewayModelsInput.value.split(/[\s,]+/).filter(m => m && m !== r.model);
                gatewayModelsInput.value = [r.model, ...rest].join('\n');
            }
            if (llmProviderSelect) llmProviderSelect.value = 'gateway';
            curlInput.value = '';
            curlStatus.textContent = r.warning || 'Applied. Endpoint, key and model saved.';
            saveSettings();
        });
    }

    // ── Custom provider: discover / test ─────────────────────────────────
    // These use the values typed in the form, so nothing has to be saved first.
    const gatewayOptions = () => ({
        apiKey: gatewayKeyInput ? gatewayKeyInput.value.trim() : '',
        baseUrl: gatewayBaseUrlInput ? gatewayBaseUrlInput.value.trim() : '',
        auth: gatewayAuthSelect ? gatewayAuthSelect.value : '',
        format: gatewayFormatSelect ? gatewayFormatSelect.value : ''
    });
    const modelLines = () => (gatewayModelsInput ? gatewayModelsInput.value : '').split(/[\s,]+/).filter(Boolean);
    const setStatus = (el, text, kind) => {
        if (!el) return;
        el.textContent = text;
        el.className = 'gw-status' + (kind ? ' ' + kind : '');
    };
    const withBusy = async (btn, fn) => {
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        try { await fn(); } finally { btn.disabled = false; }
    };

    if (gwAutoPickBtn) gwAutoPickBtn.addEventListener('click', () => withBusy(gwAutoPickBtn, async () => {
        setStatus(gwModelStatus, 'Testing models with your key. This can take up to a minute...');
        if (gwTestResults) { gwTestResults.hidden = true; gwTestResults.textContent = ''; }
        const r = await window.electronAPI.gatewayAutoPick(Object.assign(gatewayOptions(), { freeOnly: !!(gatewayFreeOnlyInput && gatewayFreeOnlyInput.checked) }));
        if (!r.success) return setStatus(gwModelStatus, r.error || 'Auto-pick failed.', 'err');
        gatewayModelsInput.value = r.models.join('\n');
        if (gwTestResults) {
            gwTestResults.hidden = false;
            r.working.forEach((w, i) => {
                const row = document.createElement('div');
                row.className = 'gw-row';
                const name = document.createElement('span');
                name.textContent = (i === 0 ? 'default  ' : i < r.models.length ? 'fallback ' : 'also ok  ') + w.model;
                const res = document.createElement('span');
                res.className = 'ok';
                res.textContent = w.latency + ' ms';
                row.append(name, res);
                gwTestResults.appendChild(row);
            });
        }
        saveSettings();
        const scope = r.freeOnly ? 'free models' : (gatewayFreeOnlyInput && gatewayFreeOnlyInput.checked && !r.freeKnown ? 'models (this gateway does not mark free ones)' : 'models');
        setStatus(gwModelStatus, r.working.length + ' of ' + r.tested + ' tested ' + scope + ' answer (' + r.listed + ' listed). Kept the fastest ' + r.models.length + ': the first is the default, the rest are fallbacks.', 'ok');
    }));

    let discovered = [];
    const renderDiscovered = () => {
        if (!gwDiscoverList) return;
        const q = (gwDiscoverFilter ? gwDiscoverFilter.value : '').trim().toLowerCase();
        const have = new Set(modelLines());
        gwDiscoverList.textContent = '';
        discovered.filter(m => !q || m.toLowerCase().includes(q)).slice(0, 300).forEach(m => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = (have.has(m) ? '✓ ' : '+ ') + m;
            b.addEventListener('click', () => {
                const cur = modelLines();
                if (cur.includes(m)) return;
                gatewayModelsInput.value = [...cur, m].join('\n');
                saveSettings();
                renderDiscovered();
            });
            gwDiscoverList.appendChild(b);
        });
    };
    if (gwDiscoverFilter) gwDiscoverFilter.addEventListener('input', renderDiscovered);

    if (gwDiscoverBtn) gwDiscoverBtn.addEventListener('click', () => withBusy(gwDiscoverBtn, async () => {
        setStatus(gwModelStatus, 'Fetching models...');
        const r = await window.electronAPI.gatewayListModels(gatewayOptions());
        if (!r.success) {
            if (gwDiscoverBox) gwDiscoverBox.hidden = true;
            return setStatus(gwModelStatus, r.error || 'Discovery failed.', 'err');
        }
        discovered = r.models;
        if (gwDiscoverBox) gwDiscoverBox.hidden = false;
        if (gwDiscoverFilter) gwDiscoverFilter.value = '';
        renderDiscovered();
        setStatus(gwModelStatus, r.models.length + ' models found. Click one to add it; the first in the list is the default.', 'ok');
    }));

    if (gwTestModelsBtn) gwTestModelsBtn.addEventListener('click', () => withBusy(gwTestModelsBtn, async () => {
        const models = modelLines();
        if (!models.length) return setStatus(gwModelStatus, 'Add at least one model to the list first.', 'err');
        if (gwTestResults) { gwTestResults.hidden = false; gwTestResults.textContent = ''; }
        let okCount = 0;
        for (const model of models.slice(0, 8)) {
            setStatus(gwModelStatus, 'Testing ' + model + '...');
            const r = await window.electronAPI.gatewayTestModel(model, gatewayOptions());
            if (r.success) okCount++;
            if (gwTestResults) {
                const row = document.createElement('div');
                row.className = 'gw-row';
                const name = document.createElement('span');
                name.textContent = model;
                const res = document.createElement('span');
                res.className = r.success ? 'ok' : 'err';
                res.textContent = r.success ? 'OK ' + r.latency + ' ms' : r.error;
                row.append(name, res);
                gwTestResults.appendChild(row);
            }
        }
        const total = Math.min(models.length, 8);
        setStatus(gwModelStatus, okCount + ' of ' + total + ' models work' + (models.length > 8 ? ' (first 8 tested)' : '') + '.', okCount === total ? 'ok' : 'err');
    }));

    if (gwTestApiBtn) gwTestApiBtn.addEventListener('click', () => withBusy(gwTestApiBtn, async () => {
        setStatus(gwApiStatus, 'Testing...');
        const r = await window.electronAPI.gatewayTestApi(Object.assign(gatewayOptions(), { models: modelLines() }));
        if (!r.success) return setStatus(gwApiStatus, r.error || 'API test failed.', 'err');
        const detail = r.modelCount != null ? r.modelCount + ' models available' : (r.note || 'reachable');
        setStatus(gwApiStatus, 'Connected (' + r.format + ' format, ' + r.latency + ' ms, ' + detail + ').', 'ok');
    }));

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperDeviceSelect,
        whisperCaptureModeSelect,
        whisperSegmentMsInput,
        geminiKeyInput,
        gatewayKeyInput,
        gatewayModelsInput,
        gatewayEffortSelect,
        gatewayDiscoveryInput,
        gatewayFreeOnlyInput,
        autoScreenInput,
        gatewayBaseUrlInput,
        gatewayAuthSelect,
        gatewayFormatSelect,
        llmProviderSelect,
        llmRoutingSelect
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                window.electronAPI.saveSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            syncCodingLanguageState();
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    updateSpeechFieldStates();
    syncCodingLanguageState();

    // Follow skill changes made elsewhere (shortcut or main window).
    window.api.receive('skill-updated', (data) => {
        if (data && data.skill && activeSkillSelect) {
            activeSkillSelect.value = data.skill;
            syncCodingLanguageState();
        }
    });
    if (window.electronAPI && window.electronAPI.onSkillChanged) {
        window.electronAPI.onSkillChanged((event, data) => {
            if (data && data.skill && activeSkillSelect) {
                activeSkillSelect.value = data.skill;
                syncCodingLanguageState();
            }
        });
    }

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;

            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];

                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };

                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };

                img.onerror = tryNextPath;
                tryNextPath();
            };

            const label = document.createElement('div');
            label.textContent = icon.name;

            iconElement.appendChild(img);
            iconElement.appendChild(label);

            // Click handler for icon selection
            iconElement.addEventListener('click', () => {
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });

                // Add selection to clicked icon
                iconElement.classList.add('selected');

                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });

                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });

            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
});
