// Ensure all necessary elements are selected
const sendButton = document.querySelector('#send-button');
const stopButton = document.querySelector('#stop-button');
const retryButton = document.querySelector('#retry-button');
const form = document.querySelector('form');
const input = document.querySelector('#chat');
const resultat = document.querySelector('#reponse');
const modelSelect = document.querySelector('#model-select');

// Add history list element reference
const historyList = document.querySelector('#history-list');

let currentController = null;
let lastUserMessage = null;
let currentRequestId = null;
let messageHistory = [];
let responseCount = 0;

const questionSummary = "Always summarize the question in one sentence. ";
const defaultSystemContent = questionSummary+"You are a helpful AI assistant, always respond in the same "+
                             "language as the user. Always add a title to your messages "+ 
                             "if the question is about a specific topic. Write all the "+  
                             "equations in LaTeX format.";

// Initialize default settings
let defaultSettings = {
    stream: true,
    temperature: 0.7,
    systemContent: defaultSystemContent
};

// Load settings from localStorage or use default settings
let currentSettings = JSON.parse(localStorage.getItem('settings')) || defaultSettings;

// Function to reset Ollama parameters
function resetOllamaParameters() {
    // Implement the logic to reset Ollama parameters if needed
    console.log('Ollama parameters reset to:', currentSettings);
}

// Load models on startup
async function loadModels() {
    try {
        const response = await fetch('/models');
        if (!response.ok) throw new Error('Error loading models');

        const data = await response.json();
        if (!Array.isArray(data.models)) {
            console.error('Invalid response format:', data);
            return;
        }

        modelSelect.innerHTML = data.models
            .map(model => `<option value="${model.name}">${model.name}</option>`)
            .join('');

        currentModel = localStorage.getItem('selectedModel') || data.models[0]?.name;
        if (currentModel) {
            modelSelect.value = currentModel;
        }
    } catch (error) {
        console.error('Error loading models:', error);
    }
}

// Save model selection
modelSelect.addEventListener('change', (e) => {
    currentModel = e.target.value;
    localStorage.setItem('selectedModel', currentModel);
});

// Load models on startup
loadModels();

// Stop request function
async function stopRequest() {
    if (currentController) {
        currentController.abort();
    }
    if (currentRequestId) {
        try {
            await fetch('/chat/stop', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ requestId: currentRequestId })
            });
        } catch (error) {
            console.error('Error stopping request:', error);
        } finally {
            currentRequestId = null;
            stopButton.disabled = true;
            sendButton.disabled = false;
            retryButton.disabled = false;
        }
    }
}

function showLoadingIndicator() {
    document.getElementById('loading-indicator').style.display = 'block';
    input.disabled = true; // Disable input field
}

function hideLoadingIndicator() {
    document.getElementById('loading-indicator').style.display = 'none';
    input.disabled = false; // Enable input field
}

// Function to summarize question (basic implementation)
function summarizeQuestion(question) {
    // Take first 30 characters and add ellipsis if longer
    return question.length > 30 ? question.substring(0, 30) + '...' : question;
}

// Load history from server
async function loadHistory() {
    try {
        const response = await fetch('/history');
        if (!response.ok) throw new Error('Error loading history');
        const history = await response.json();
        history.reverse().forEach(question => addToHistory(question.question, question.id));
    } catch (error) {
        console.error('Error loading history:', error);
    }
}

// Function to add question to history
async function addToHistory(question, id) {
    // Check if the question already exists in the history list
    if (document.querySelector(`.history-item[data-id="${id}"]`)) {
        return;
    }

    const historyItem = document.createElement('div');
    historyItem.className = 'history-item';
    historyItem.textContent = summarizeQuestion(question);
    historyItem.title = question; // Full question as tooltip
    historyItem.dataset.id = id; // Store the question ID
    
    // Click handler to load the discussion
    historyItem.addEventListener('click', async () => {
        await loadDiscussion(id);
    });
    
    // Insert at the top of the list
    historyList.insertBefore(historyItem, historyList.firstChild);

    // Save to server if ID is not provided (new question)
    if (!id) {
        try {
            const response = await fetch('/history', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question })
            });
            const result = await response.json();
            if (result.success) {
                historyItem.dataset.id = result.id;
            }
        } catch (error) {
            console.error('Error saving history:', error);
        }
    }
}

// Load discussion for a question
async function loadDiscussion(questionId) {
    resultat.innerHTML = '';
    messageHistory = []; // Réinitialiser localement
    try {
        const response = await fetch(`/discussion/${questionId}`);
        if (!response.ok) throw new Error('Error loading discussion');
        const messages = await response.json();

        // Afficher chaque message
        messages.forEach(msg => {
            const decrypted = crypto.AES.decrypt(msg.message, 'secret-key').toString(crypto.enc.Utf8);
            messageHistory.push({ role: msg.role, content: decrypted });
            displayMessage({ role: msg.role, content: decrypted });
        });
    } catch (error) {
        console.error('Error loading discussion:', error);
    }
}

// Load history on startup
loadHistory();

// Send message function
async function sendMessage(e) {
    e.preventDefault();
    sendButton.disabled = true;
    stopButton.disabled = false;  // Enable the stop button
    retryButton.disabled = true;

    const content = input.value.trim();
    if (!content) return;

    // Add to history before sending
    addToHistory(content);

    responseCount = 0;
    lastUserMessage = content;

    if (currentController) {
        currentController.abort();
    }
    currentController = new AbortController();

    try {
        showLoadingIndicator();
        const userMessage = { role: 'user', content };
        messageHistory.push(userMessage);
        displayMessage(userMessage);
        input.value = '';

        const assistantMessage = { role: 'assistant', content: '' };

        const response = await fetch('/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messages: [userMessage],
                model: currentModel,
                stream: currentSettings.stream,
                options: {
                    temperature: currentSettings.temperature,
                    system: currentSettings.systemContent
                }
            }),
            signal: currentController.signal
        });

        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        const messageElement = displayMessage(assistantMessage);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const text = decoder.decode(value, { stream: true });
            console.log('Received from server:', text); // Debug

            const lines = text.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        console.log('Parsed data:', data); // Debug
                        if (data.requestId) {
                            currentRequestId = data.requestId;
                            continue;
                        }
                        assistantMessage.content += data.content || '';
                        messageElement.querySelector('.message-content').innerHTML = marked.parse(assistantMessage.content);
                        messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });

                        const chatContainer = document.querySelector('.chat-container');
                        chatContainer.scrollTop = chatContainer.scrollHeight;

                        hljs.highlightAll();

                        // Hide loading indicator when response starts arriving
                        hideLoadingIndicator();
                    } catch (e) {
                        console.error('Error parsing JSON:', e, line);
                    }
                }
            }
        }

        if (assistantMessage.content) {
            messageHistory.push(assistantMessage);
            await saveMessageToDiscussion(lastUserMessage, assistantMessage.content);
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('Request canceled');
        } else {
            console.error('Error:', error);
            resultat.innerHTML += `<div class="message error-message">Error: ${error.message}</div>`;
        }
    } finally {
        hideLoadingIndicator();
        currentRequestId = null;
        sendButton.disabled = false;
        stopButton.disabled = true;
        retryButton.disabled = false;
    }
}

// Save message to discussion
async function saveMessageToDiscussion(question, message) {
    try {
        const questionId = document.querySelector('.history-item').dataset.id;
        await fetch('/discussion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionId, message, role: 'assistant' })
        });
    } catch (error) {
        console.error('Error saving message to discussion:', error);
    }
}

// Add event listeners
sendButton.addEventListener('click', sendMessage);
stopButton.addEventListener('click', stopRequest);
form.addEventListener('submit', sendMessage);

// Function to display a message
function displayMessage(message) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${message.role}-message`;

    const header = document.createElement('div');
    header.className = 'message-header';
    if (message.role === 'assistant') {
        responseCount++;
        header.textContent = `Assistant (Answer ${responseCount} - ${currentModel})`;
    } else {
        header.textContent = 'You';
    }

    const content = document.createElement('div');
    content.className = 'message-content';

    content.innerHTML = marked.parse(message.content);
    hljs.highlightAll();

    const copyButton = document.createElement('button');
    copyButton.className = 'copy-button';
    copyButton.innerHTML = `<svg class="copy-icon"><use href="#copy-icon"/></svg>`;
    copyButton.title = 'Copy message';
    copyButton.onclick = () => {
        navigator.clipboard.writeText(message.content)
            .then(() => {
                copyButton.style.backgroundColor = '#4CAF50';
                setTimeout(() => {
                    copyButton.style.backgroundColor = '';
                }, 1000);
            })
            .catch(err => console.error('Error copying:', err));
    };
    messageDiv.appendChild(copyButton);

    if (message.role === 'user') {
        const editButton = document.createElement('button');
        editButton.className = 'edit-button';
        editButton.innerHTML = `<svg class="edit-icon"><use href="#edit-icon"/></svg>`;
        editButton.title = 'Edit question';
        editButton.onclick = () => {
            input.value = message.content;
            sendButton.disabled = false;
            stopButton.disabled = true;
            input.focus();
            const nextSiblings = [];
            let nextSibling = messageDiv.nextSibling;
            while (nextSibling) {
                nextSiblings.push(nextSibling);
                nextSibling = nextSibling.nextSibling;
            }
            nextSiblings.forEach(sibling => sibling.remove());
            messageDiv.remove();
        };
        messageDiv.appendChild(editButton);
    }

    if (message.role === 'assistant') {
        const saveButton = document.createElement('button');
        saveButton.className = 'save-button';
        saveButton.innerHTML = `<svg class="save-icon"><use href="#save-icon"/></svg>`;
        saveButton.title = 'Save answer';
        saveButton.onclick = () => {
            const extension = prompt("Enter the file extension (for example, txt, md, etc.)", "txt");
            if (extension) {
                const blob = new Blob([message.content], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `answer.${extension}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }
        };
        messageDiv.appendChild(saveButton);
    }

    messageDiv.appendChild(header);
    messageDiv.appendChild(content);
    resultat.appendChild(messageDiv);

    return messageDiv;
}

// Handle About modal
const aboutButton = document.getElementById('about-button');
const aboutModal = document.getElementById('about-modal');
const closeAbout = document.getElementById('close-about');

aboutButton.addEventListener('click', () => {
    aboutModal.style.display = 'flex';
});

closeAbout.addEventListener('click', () => {
    aboutModal.style.display = 'none';
});

window.addEventListener('click', (event) => {
    if (event.target === aboutModal) {
        aboutModal.style.display = 'none';
    }
});

// Handle Settings Modal
const settingsButton = document.getElementById('settings-button');
const settingsModal = document.getElementById('settings-modal');
const closeSettings = document.getElementById('close-settings');
const settingsForm = document.getElementById('settings-form');

settingsButton.addEventListener('click', () => {
    settingsForm.stream.value = currentSettings.stream.toString();
    settingsForm.temperature.value = currentSettings.temperature;
    settingsForm.systemContent.value = currentSettings.systemContent;
    settingsModal.style.display = 'flex';
});

closeSettings.addEventListener('click', () => {
    settingsModal.style.display = 'none';
});

settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    currentSettings.stream = settingsForm.stream.value === 'true';
    currentSettings.temperature = parseFloat(settingsForm.temperature.value);
    currentSettings.systemContent = settingsForm.systemContent.value;
    localStorage.setItem('settings', JSON.stringify(currentSettings));
    settingsModal.style.display = 'none';
    console.log('Settings updated:', currentSettings);
    resetOllamaParameters(); // Reset Ollama parameters whenever settings change
});

const resetSettingsButton = document.getElementById('reset-settings');

resetSettingsButton.addEventListener('click', () => {
    currentSettings = { ...defaultSettings };
    settingsForm.stream.value = currentSettings.stream.toString();
    settingsForm.temperature.value = currentSettings.temperature;
    settingsForm.systemContent.value = currentSettings.systemContent;
    localStorage.setItem('settings', JSON.stringify(currentSettings));
    console.log('Settings reset to default:', currentSettings);
    resetOllamaParameters(); // Reset Ollama parameters whenever settings change
});

retryButton.addEventListener('click', async () => {
    if (lastUserMessage) {
        try {
            showLoadingIndicator();
            const assistantMessage = { role: 'assistant', content: '' };
            const messageElement = displayMessage(assistantMessage, true);

            const response = await fetch('/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    messages: [...messageHistory, { role: 'user', content: lastUserMessage }],
                    model: currentModel,
                    stream: currentSettings.stream,
                    options: {
                        temperature: currentSettings.temperature,
                        system: currentSettings.systemContent
                    }
                })
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            sendButton.disabled = true;
            stopButton.disabled = false;
            retryButton.disabled = true;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value, { stream: true });
                const lines = text.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.requestId) {
                                currentRequestId = data.requestId;
                                continue;
                            }
                            assistantMessage.content += data.content || '';
                            messageElement.querySelector('.message-content').innerHTML = marked.parse(assistantMessage.content);
                            messageElement.scrollIntoView({ behavior: 'smooth', block: 'end' });

                            const chatContainer = document.querySelector('.chat-container');
                            chatContainer.scrollTop = chatContainer.scrollHeight;

                            hljs.highlightAll();

                            // Hide loading indicator when response starts arriving
                            hideLoadingIndicator();
                        } catch (e) {
                            console.error('Error parsing JSON:', e, line);
                        }
                    }
                }
            }

            if (assistantMessage.content) {
                messageHistory.push({ role: 'user', content: lastUserMessage });
                messageHistory.push(assistantMessage);
            }

        } catch (error) {
            console.error('Error during retry:', error);
            resultat.innerHTML += `<div class="message error-message">Error: ${error.message}</div>`;
        } finally {
            hideLoadingIndicator();
            currentRequestId = null;
            sendButton.disabled = false;
            stopButton.disabled = true;
            retryButton.disabled = false;
        }
    }
});

const themeToggleButton = document.getElementById('theme-toggle-button');

themeToggleButton.addEventListener('click', () => {
    document.body.classList.toggle('light-mode');
    const isLightMode = document.body.classList.contains('light-mode');
    localStorage.setItem('theme', isLightMode ? 'light' : 'dark');
});

// Load theme from localStorage
const savedTheme = localStorage.getItem('theme') || 'dark';
if (savedTheme === 'light') {
    document.body.classList.add('light-mode');
}
