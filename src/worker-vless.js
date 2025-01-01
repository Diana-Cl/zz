// <!--GAMFC-->Last update 2024-12-10 01:58:26 UTC,, version base on commit cfbe5e3cd129d66cf45a5d1248d286d5e9f16345<!--GAMFC-END-->.
// @ts-ignore
import { connect } from 'cloudflare:sockets';

function encodeSecure(str) {
    return btoa(str.split('').reverse().join(''));
}

function decodeSecure(encoded) {
    return atob(encoded).split('').reverse().join('');
}

const ENCODED = {
    PROTOCOL: 'c3NlbHY=', 
    NETWORK: 'c3c=', 
    TYPE: 'YW5haWQ=', 
    STREAM: 'bWFlcnRz' , 
    V2RAY: 'bGl2RVJpTg==' 
};

// To generate your own UUID: https://www.uuidgenerator.net/
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"
let userCode = '10e894da-61b1-4998-ac2b-e9ccb6af9d30';

// Find proxyIP: https://github.com/NiREvil/vless/blob/main/sub/ProxyIP.md
let proxyIP = 'turk.radicalization.ir';// OR use 'nima.nscl.ir 

if (!isValidUserCode(userCode)) {
    throw new Error('user code is not valid');
}

export default {
    async fetch(request, env, ctx) {
        try {
            userCode = env.UUID || userCode;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf), { status: 200 });
                    case `/${userCode}`: {
                        const streamConfig = getDianaConfig(userCode, request.headers.get('Host'));
                        return new Response(`${streamConfig}`, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            }
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await streamOverWSHandler(request);
            }
        } catch (err) {
            let e = err;
            return new Response(e.toString());
        }
    },
};

async function streamOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);

    webSocket.accept();

    let address = '';
    let portWithRandomLog = '';
    const log = (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    let remoteSocketWapper = {
        value: null,
    };
    let udpStreamWrite = null;
    let isDns = false;

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter()
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                streamVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processStreamHeader(chunk, userCode);
            
            address = addressRemote;
            portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;
            
            if (hasError) {
                throw new Error(message);
                return;
            }

            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    throw new Error('UDP proxy only enable for DNS which is port 53');
                    return;
                }
            }

            const streamResponseHeader = new Uint8Array([streamVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);

            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, streamResponseHeader, log);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }
            handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, streamResponseHeader, log);
        },
        close() {
            log(`readableWebSocketStream is close`);
        },
        abort(reason) {
            log(`readableWebSocketStream is abort`, JSON.stringify(reason));
        },
    })).catch((err) => {
        log('readableWebSocketStream pipeTo error', err);
    });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) {
                    return;
                }
                const message = event.data;
                controller.enqueue(message);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel) {
                    return;
                }
                controller.close();
            });

            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error');
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },

        pull(controller) {
        },
        
        cancel(reason) {
            if (readableStreamCancel) {
                return;
            }
            log(`ReadableStream was canceled, due to ${reason}`)
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });

    return stream;
}

function processStreamHeader(chunk, userCode) {
    if (chunk.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data',
        };
    }

    const version = new Uint8Array(chunk.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;

    if (stringify(new Uint8Array(chunk.slice(1, 17))) === userCode) {
        isValidUser = true;
    }

    if (!isValidUser) {
        return {
            hasError: true,
            message: 'invalid user',
        };
    }

    const optLength = new Uint8Array(chunk.slice(17, 18))[0];
    const command = new Uint8Array(chunk.slice(18 + optLength, 18 + optLength + 1))[0];

    if (command === 1) {
    } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `command ${command} is not supported`,
        };
    }

    const portIndex = 18 + optLength + 1;
    const portBuffer = chunk.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(chunk.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(chunk.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(chunk.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(chunk.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(chunk.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return {
                hasError: true,
                message: `invalid addressType: ${addressType}`,
            };
    }

    if (!addressValue) {
        return {
            hasError: true,
            message: `addressValue is empty`,
        };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        streamVersion: version,
        isUDP,
    };
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, streamResponseHeader, log) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });
        remoteSocket.value = tcpSocket;
        log(`connected to ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
        tcpSocket.closed.catch(error => {
            console.log('retry tcpSocket closed error', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        })
        remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, null, log);
    }

    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, retry, log);
}

async function remoteSocketToWS(remoteSocket, webSocket, streamResponseHeader, retry, log) {
    let remoteChunkCount = 0;
    let chunks = [];
    let vlessHeader = streamResponseHeader;
    let hasIncomingData = false;

    await remoteSocket.readable
        .pipeTo(new WritableStream({
            start() {},
            async write(chunk, controller) {
                hasIncomingData = true;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                    controller.error('webSocket is not open');
                }
                if (vlessHeader) {
                    webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
                    vlessHeader = null;
                } else {
                    webSocket.send(chunk);
                }
            },
            close() {
                log(`remoteConnection readable close`);
            },
            abort(reason) {
                console.error(`remoteConnection readable abort`, reason);
            },
        }))
        .catch((error) => {
            console.error(`remoteSocketToWS has error`, error.stack || error);
            safeCloseWebSocket(webSocket);
        });

    if (hasIncomingData === false && retry) {
        log(`retry connection`);
        retry();
    }
}

async function handleUDPOutBound(webSocket, streamResponseHeader, log) {
    let isHeaderSent = false;

    const transformStream = new TransformStream({
        start(controller) {},
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index = index + 2 + udpPakcetLength;
                controller.enqueue(udpData);
            }
        },
        flush(controller) {}
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://1.1.1.1/dns-query', {
                method: 'POST',
                headers: {
                    'content-type': 'application/dns-message',
                },
                body: chunk,
            })
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
            
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                log(`dns query success, length: ${udpSize}`);
                if (isHeaderSent) {
                    webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                } else {
                    webSocket.send(await new Blob([streamResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                    isHeaderSent = true;
                }
            }
        }
    })).catch((error) => {
        log('dns query error: ' + error)
    });

    const writer = transformStream.writable.getWriter();

    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}

function getDianaConfig(userCode, hostName) {
    const protocol = decodeSecure(ENCODED.PROTOCOL);
    const networkType = decodeSecure(ENCODED.NETWORK);
    
    const config = 
    `${protocol}://${userCode}@${hostName}:443` +
    `?encryption=none&security=tls&sni=${hostName}` +
    `&fp=randomized&type=${networkType}&host=${hostName}` +
    `&alpn=http%2F1.1&path=%2Fapi%2Fassets#${hostName}`;

    return `


${atob('VkxFU1MgcHJvdG9jb2wgY29uZmlndXJhdGlvbi4gU3VpdGFibGUgZm9yIGNsaWVudHMgc3VwcG9ydGluZyBWTEVTUw==')}
-------------------------------------------------------------------

${config}


-----------------------------------------------------
${atob('dGVsZWdyYW0gY2g6Cmh0dHBzOi8vdC5tZS9zL0ZfTmlSRXZpbA==')}
${atob('c291cmNlIGNvZGU6Cmh0dHBzOi8vZ2l0aHViLmNvbS9OaVJFdmlsL3ppemlmbg==')}
-----------------------------------------------------




${atob('Q0xBU0ggcHJvdG9jb2wgY29uZmlndXJhdGlvbi4gQmVzdCBmb3IgQ2xhc2ggdXNlcnMgb24gbW9iaWxlIGRldmljZXMu')}
---------------------------------------------------------------------

- type: ${protocol}
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userCode}
  network: ${networkType}
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ${networkType}-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}


---------------------------------------------------------------

`;
}

function isValidUserCode(code) {
    const codeRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return codeRegex.test(code);
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + 
            byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + 
            byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + 
            byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + 
            byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + 
            byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + 
            byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + 
            byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUserCode(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}
