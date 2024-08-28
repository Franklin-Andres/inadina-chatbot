const express = require('express');
const body_parser = require('body-parser');
const axios = require('axios');
const OpenAI = require('openai');
const FormData = require('form-data');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express().use(body_parser.json());

const token = process.env.WHATSAPP_TOKEN;
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    maxRetries: 3,
    timeout: 60 * 1000
});

// Configuración de la base de datos
const dbConfig = {
    host: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT, 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
};

console.log("OpenAI API Key:", process.env.OPENAI_API_KEY ? "Configurada" : "No configurada");
console.log("OpenAI Assistant ID:", process.env.OPENAI_ASSISTANT_ID);

// Store thread IDs for each user
const userThreads = new Map();

let assistant;

// Función para crear una conexión a la base de datos
async function createDbConnection() {
    return await mysql.createConnection(dbConfig);
}

// Función para guardar un usuario
async function saveUser(phone, name) {
    const connection = await createDbConnection();
    try {
        await connection.execute(
            'INSERT INTO users (phone_number, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = ?',
            [phone, name, name]
        );
    } finally {
        await connection.end();
    }
}

// Función para crear o obtener un hilo
async function getOrCreateThread(userPhone) {
    const connection = await createDbConnection();
    try {
        const [threads] = await connection.execute(
            'SELECT id FROM threads WHERE user_phone = ? LIMIT 1',
            [userPhone]
        );
        if (threads.length === 0) {
            const [result] = await connection.execute(
                'INSERT INTO threads (id, user_phone) VALUES (UUID(), ?)',
                [userPhone]
            );
            return result.insertId;
        } else {
            return threads[0].id;
        }
    } finally {
        await connection.end();
    }
}

// Función para guardar un mensaje
async function saveMessage(threadId, userPhone, content, type) {
    const connection = await createDbConnection();
    try {
        const [result] = await connection.execute(
            'INSERT INTO messages (id, thread_id, user_phone, content, type) VALUES (UUID(), ?, ?, ?, ?)',
            [threadId, userPhone, content, type]
        );
        return result.insertId;
    } finally {
        await connection.end();
    }
}

// Función para guardar una respuesta del asistente
async function saveAssistantResponse(messageId, content) {
    const connection = await createDbConnection();
    try {
        await connection.execute(
            'INSERT INTO assistant_responses (message_id, content) VALUES (?, ?)',
            [messageId, content]
        );
    } finally {
        await connection.end();
    }
}

// Función para guardar una transcripción de audio
async function saveAudioTranscription(messageId, transcription) {
    const connection = await createDbConnection();
    try {
        await connection.execute(
            'INSERT INTO audio_transcriptions (message_id, transcription) VALUES (?, ?)',
            [messageId, transcription]
        );
    } finally {
        await connection.end();
    }
}

async function verifyAssistant() {
    try {
        assistant = await openai.beta.assistants.retrieve(process.env.OPENAI_ASSISTANT_ID);
        console.log("Asistente verificado:", assistant.name);
    } catch (error) {
        console.error("Error al verificar el asistente:", error.message);
        process.exit(1); // Termina la aplicación si no se puede verificar el asistente
    }
}

async function createThread() {
    try {
        return await openai.beta.threads.create();
    } catch(error) {
        console.log(error.name, error.message);
        throw error;
    }
}

async function getThread({threadId,}) {
    try {
        return await openai.beta.threads.retrieve(threadId);
    } catch(error) {
        console.log(error.name, error.message);
        return {
            error: true,
            message: error.message,
        };
    }
}

async function deleteThread({threadId,}) {
    try {
        return await openai.beta.threads.del(threadId);
    } catch(error) {
        console.log(error.name, error.message);
        return {
            error: true,
            message: error.message,
        };
    }
}

async function addMessage({threadId, message, messageId, userId, name,}) {
    try {
        let metadata = {
            id: messageId,
            name: name,
            user_id: userId
        };
        return await openai.beta.threads.messages.create(
            threadId,
            {
                role: 'user',
                content: message,
                metadata,
            }
        );
    } catch(error) {
        console.log(error.name, error.message);
        throw error;
    }
}

async function getMessages({threadId,}) {
    try {
        const messages = await openai.beta.threads.messages.list(threadId);
        return messages.data;
    } catch(error) {
        console.log(error.name, error.message);
        throw error;
    }
}

async function startRun({threadId, instructions}) {
    try {
        let options = {
            assistant_id: process.env.OPENAI_ASSISTANT_ID,
        };
        if(instructions) {
            options.instructions = instructions;
        }
        return await openai.beta.threads.runs.create(threadId, options);
    } catch(error) {
        console.log(error.name, error.message);
        throw error;
    }
}

async function getRun({threadId, runId,}) {
    try {
        return await openai.beta.threads.runs.retrieve(threadId, runId);
    } catch(error) {
        console.log(error.name, error.message);
        throw error;
    }
}

async function submitOutputs({threadId, runId, tool_outputs}) {
    try {
        return await openai.beta.threads.runs.submitToolOutputs(
            threadId, 
            runId,
            {
                tool_outputs: tool_outputs,
            }
        );
    } catch(error) {
        console.log(error.name, error.message);
        throw error;
    }
}

async function chatCompletion({
    model = 'gpt-4',
    max_tokens = 2048,
    temperature = 0,
    messages,
    tools,
}) {
    let options = { messages, model, temperature, max_tokens };
    if(tools) {
        options.tools = tools;
    }
    try {
        const result = await openai.chat.completions.create(options);
        console.log(result);
        return result.choices[0];
    } catch(error) {
        console.log(error.name, error.message);
        throw error;
    }
}

const transcriptAudio = async (mediaId) => {
    try {
        const mediaUrl = `https://graph.facebook.com/v17.0/${mediaId}`;
        const mediaResponse = await axios.get(mediaUrl, {
            headers: { Authorization: `Bearer ${token}` },
            params: { access_token: token }
        });

        const fileResponse = await axios.get(mediaResponse.data.url, {
            responseType: 'arraybuffer',
            headers: { Authorization: `Bearer ${token}` }
        });

        const transcription = await openai.audio.transcriptions.create({
            file: new Blob([Buffer.from(fileResponse.data)], { type: 'audio/ogg' }),
            model: 'whisper-1',
        });
        return transcription.text;
    } catch (error) {
        console.error('Error transcribing audio:', error.response ? error.response.data : error.message);
        throw error;
    }
};

const processMessage = async (from, content, name, type = 'text') => {
    try {
        await saveUser(from, name);
        const threadId = await getOrCreateThread(from);
        const messageId = await saveMessage(threadId, from, content, type);

        if (type === 'audio') {
            await saveAudioTranscription(messageId, content);
        }

        let openAIThreadId;
        if (!userThreads.has(from)) {
            const thread = await createThread();
            openAIThreadId = thread.id;
            userThreads.set(from, openAIThreadId);
        } else {
            openAIThreadId = userThreads.get(from);
        }

        await addMessage({
            threadId: openAIThreadId,
            message: content,
            messageId: messageId,
            userId: from,
            name: name || 'User'
        });

        const run = await startRun({ threadId: openAIThreadId });

        let runStatus;
        let attempts = 0;
        const maxAttempts = 10;
        do {
            runStatus = await getRun({ threadId: openAIThreadId, runId: run.id });
            await new Promise(resolve => setTimeout(resolve, 1000));
            attempts++;
            if (attempts >= maxAttempts) {
                throw new Error("Tiempo de espera excedido para la respuesta del asistente");
            }
        } while (runStatus.status !== 'completed' && runStatus.status !== 'failed');

        if (runStatus.status === 'failed') {
            throw new Error("La ejecución del asistente falló: " + runStatus.last_error?.message);
        }

        const messages = await getMessages({ threadId: openAIThreadId });
        const response = messages[0].content[0].text.value;
        
        await saveAssistantResponse(messageId, response);

        return response;
    } catch (error) {
        console.error('Error processing message:', error.message);
        if (error.message.includes("No assistant found")) {
            return "Lo siento, hay un problema con la configuración del asistente. Por favor, contacta al soporte.";
        }
        return "Lo siento, hubo un error al procesar tu mensaje. Por favor, inténtalo de nuevo más tarde.";
    }
};

const sendMessage = async (phone_number_id, to, text) => {
    try {
        await axios({
            method: "POST",
            url: `https://graph.facebook.com/v12.0/${phone_number_id}/messages?access_token=${token}`,
            data: {
                messaging_product: "whatsapp",
                to: to,
                text: { body: text },
            },
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        console.error('Error sending message:', error.response ? error.response.data : error.message);
        throw error;
    }
};

app.post("/webhook", async (req, res) => {
    try {
        if (req.body.object) {
            if (
                req.body.entry &&
                req.body.entry[0].changes &&
                req.body.entry[0].changes[0] &&
                req.body.entry[0].changes[0].value.messages &&
                req.body.entry[0].changes[0].value.messages[0]
            ) {
                const phone_number_id = req.body.entry[0].changes[0].value.metadata.phone_number_id;
                const from = req.body.entry[0].changes[0].value.messages[0].from;
                const msg_type = req.body.entry[0].changes[0].value.messages[0].type;
                const name = req.body.entry[0].changes[0].value.contacts[0].profile.name;

                let content;
                if (msg_type === "text") {
                    content = req.body.entry[0].changes[0].value.messages[0].text.body;
                } else if (msg_type === "audio") {
                    await sendMessage(phone_number_id, from, "Procesando nota de voz. Espera...");
                    content = await transcriptAudio(req.body.entry[0].changes[0].value.messages[0].audio.id);
                    await sendMessage(phone_number_id, from, `*Transcripción del audio:*\n\n"${content}"\n\n_Procesando con el asistente..._`);
                }

                const response = await processMessage(from, content, name, msg_type);
                await sendMessage(phone_number_id, from, response);
            }
            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        console.error('Error in webhook:', error.response ? error.response.data : error.message);
        res.status(500).send('Internal Server Error');
    }
});

app.get("/webhook", (req, res) => {
    const verify_token = process.env.VERIFY_TOKEN;
    let mode = req.query["hub.mode"];
    let token = req.query["hub.verify_token"];
    let challenge = req.query["hub.challenge"];

    if (mode && token) {
        if (mode === "subscribe" && token === verify_token) {
            console.log("WEBHOOK_VERIFIED");
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Verificar el asistente antes de iniciar el servidor
verifyAssistant().then(() => {
    const PORT = process.env.PORT || 1337;
    app.listen(PORT, () => {
        console.log(`Webhook is listening on port ${PORT}`);
        console.log(`Node.js version: ${process.version}`);
    });
}).catch(error => {
    console.error("Error al iniciar la aplicación:", error);
});