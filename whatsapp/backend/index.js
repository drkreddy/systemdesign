import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import 'dotenv/config';
import { log } from 'console';

const app = express();
const PORT = process.env.PORT || 5000;

const server = createServer(app);


app.use(express.json());

app.get('/', (req, res) => {
    res.json({ message: "Backend server running smoothly!" });
});
const wss = new WebSocketServer({ server , path:'/chat'});

const clientsByName = new Map();
const offlineMessages = new Map();

wss.on('connection', (ws) => {
    console.log('⚡ New client connected!');
    ws.on('message', (message) => {
        console.log(`📩 Received: ${message}`);

        let parsed;
        try {
            parsed = JSON.parse(message.toString());
        } catch (e) {
            return;
        }

        if (parsed.name) {
            clientsByName.set(parsed.name, ws);

            const pending = offlineMessages.get(parsed.name);
            if (pending && pending.length > 0) {
                pending.forEach((pendingMessage) => ws.send(pendingMessage));
                offlineMessages.delete(parsed.name);
            }
        }

        if (parsed.type === 'announce') {
            return;
        }

        if (parsed.direct && parsed.to) {
            const recipient = clientsByName.get(parsed.to);
            if (recipient && recipient.readyState === 1) {
                recipient.send(message.toString());
            } else {
                if (!offlineMessages.has(parsed.to)) {
                    offlineMessages.set(parsed.to, []);
                }
                offlineMessages.get(parsed.to).push(message.toString());
            }
            return;
        }

        wss.clients.forEach((client) => {
            if (client !=ws && client.readyState === 1) {
                client.send(message.toString());
            }
        });
    });
    // Handle client disconnection
    ws.on('close', () => {
        console.log('❌ Client disconnected');
        for (const [name, socket] of clientsByName.entries()) {
            if (socket === ws) clientsByName.delete(name);
        }
    });

});

//start server
server.listen(PORT, () => {
    console.log(`Server started successfully on port ${PORT}`);
});