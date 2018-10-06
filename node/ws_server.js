const WebSocketServer = require('ws').Server
const ws_server = new WebSocketServer({port: 8080})

ws_server.on('connection', function (ws, req) { // ws is the current client browser
    ws.on('message', function (message_string) {

        let message = JSON.parse(message_string)

        switch (message.action) {

            case 'ping':
                break

            case 'subscribe':
                ws.pathname = message.pathname
                break

            default:
                ws_server.clients.forEach(client => {
                    if (client == ws) return // ws is socket message came in on; do not echo message back to sender
                    if (client.pathname == message.pathname) client.send(message_string) // if some other client is subscribed to this pathname, send message
                })
        }

    })
})
