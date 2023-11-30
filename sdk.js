// p2p
var clientP2P;
var clientRTN;
var clientP2PTimer;
var clientRTNTimer;

var botmode = false;
var drawInterval = 10; // seconds

var localAudioTrack, localVideoTrack;

AgoraRTC.setParameter("P2P", true);
onload();

async function onload() {
    await createTracks();
    await init();

    if (botmode) return;

    dataset = { time: [], data: [] };
    dataset.data["rtn"] = {}
    dataset.data["p2p"] = {}
    initCharts();
    setInterval(() => {
        var d = new Date();
        dataset.time.push(d.getHours() + ":" + d.getMinutes() + ":" + d.getSeconds());

        addJitter(dataset.data.rtn["chart_in_jitter"], clientRTN.stats["in"]["jitter"]);
        addJitter(dataset.data.p2p["chart_in_jitter"], clientP2P.stats["in"]["jitter"]);
        jitterChart.update();

        addJB(dataset.data.rtn["chart_in_jb"], clientRTN.stats["in"]["jitterBufferDelay"],
              clientRTN.stats["in"]["jitterBufferEmittedCount"]);
        addJB(dataset.data.p2p["chart_in_jb"], clientP2P.stats["in"]["jitterBufferDelay"],
              clientP2P.stats["in"]["jitterBufferEmittedCount"]);
        jbChart.update();

        addBitrate(dataset.data.rtn["chart_in_kbps"], clientRTN.stats["in"]["bytesReceived"]);
        addBitrate(dataset.data.p2p["chart_in_kbps"], clientP2P.stats["in"]["bytesReceived"]);
        inkbpsChart.update();

        addBitrate(dataset.data.rtn["chart_out_kbps"], clientRTN.stats["out"]["bytesSent"]);
        addBitrate(dataset.data.p2p["chart_out_kbps"], clientP2P.stats["out"]["bytesSent"]);
        outkbpsChart.update();

        addNack(dataset.data.rtn["chart_in_nack"], clientRTN.stats["in"]["nackCount"]);
        addNack(dataset.data.p2p["chart_in_nack"], clientP2P.stats["in"]["nackCount"]);
        innackChart.update();

        addNack(dataset.data.rtn["chart_out_nack"], clientRTN.stats["out"]["nackCount"]);
        addNack(dataset.data.p2p["chart_out_nack"], clientP2P.stats["out"]["nackCount"]);
        outnackChart.update();

        addNack(dataset.data.rtn["chart_in_fps"], clientRTN.stats["in"]["framesReceived"]);
        addNack(dataset.data.p2p["chart_in_fps"], clientP2P.stats["in"]["framesReceived"]);
        infpsChart.update();

        addNack(dataset.data.rtn["chart_out_fps"], clientRTN.stats["out"]["framesSent"]);
        addNack(dataset.data.p2p["chart_out_fps"], clientP2P.stats["out"]["framesSent"]);
        outfpsChart.update();

        addResolution(dataset.data.rtn["chart_out_width"], clientRTN.stats["out"]["frameWidth"]);
        addResolution(dataset.data.p2p["chart_out_width"], clientP2P.stats["out"]["frameWidth"]);
        widthChart.update();

        addResolution(dataset.data.rtn["chart_out_height"], clientRTN.stats["out"]["frameHeight"]);
        addResolution(dataset.data.p2p["chart_out_height"], clientP2P.stats["out"]["frameHeight"]);
        heightChart.update();

        addLoss(dataset.data.rtn["chart_in_loss"], clientRTN.stats["in"]["packetsLost"], clientRTN.stats["in"]["packetsReceived"]);
        addLoss(dataset.data.p2p["chart_in_loss"], clientP2P.stats["in"]["packetsLost"], clientP2P.stats["in"]["packetsReceived"]);
        lossChart.update();

        addRtt(dataset.data.rtn["chart_in_rtt"], clientRTN.stats["in"]["totalRoundTripTime"],
               clientRTN.stats["in"]["roundTripTimeMeasurements"]);
        addRtt(dataset.data.p2p["chart_in_rtt"], clientP2P.stats["in"]["totalRoundTripTime"],
               clientP2P.stats["in"]["roundTripTimeMeasurements"]);
        rttChart.update();

        addBwe(dataset.data.rtn["chart_out_bwe"], clientRTN.stats["out"]["availableOutgoingBitrate"]);
        addBwe(dataset.data.p2p["chart_out_bwe"], clientP2P.stats["out"]["availableOutgoingBitrate"]);
        outbweChart.update();

    }, drawInterval * 1000);
}

function addJitter(data, samples) {
    // convert to milliseconds
    if (data == undefined || samples == undefined) return;
    data.push(Math.trunc(samples.reduce((a, b) => a + b.val * 1000, 0) / samples.length));
    samples.length = 0;
}

function addJB(data, delay, count) {
    if (data == undefined || delay == undefined || count == undefined) return;
    data.push(Math.trunc((delay[delay.length - 1].val - delay[0].val) * 1000) / (count[count.length - 1].val - count[0].val));
    delay.length = 0;
    count.length = 0;
}

function addBitrate(data, samples) {
    if (data == undefined || samples == undefined) return;
    data.push(Math.max(0, Math.trunc(
        (samples[samples.length - 1].val - samples[0].val) * 8 / (samples[samples.length - 1].time - samples[0].time))));
    samples.length = 0;
}

function addNack(data, samples) {
    if (data == undefined || samples == undefined) return;
    data.push(Math.max(0, Math.trunc(
        (samples[samples.length - 1].val - samples[0].val) * 1000 / (samples[samples.length - 1].time - samples[0].time))));
    samples.length = 0;
}

function addFps(data, samples) {
    // in the same calc
    addNack(data, samples);
}

function addResolution(data, samples) {
    if (data == undefined || samples == undefined) return;
    data.push(samples[samples.length - 1].val);
    samples.length = 0;
}

function addBwe(data, samples) {
    if (data == undefined || samples == undefined) return;
    data.push(Math.trunc(samples.reduce((a, b) => a + b.val / 1024, 0) / samples.length));
    samples.length = 0;
}

function addLoss(data, lost, sum) {
    if (data == undefined || lost == undefined || sum == undefined) return;
    data.push(1.0 * Math.max(lost[lost.length - 1].val - lost[0].val, 0) / (sum[sum.length - 1].val - sum[0].val));
    lost.length = 0;
    sum.length = 0;
}

function addRtt(data, total, times) {
    if (data == undefined || total == undefined || times == undefined) return;
    data.push(Math.max(0, Math.trunc(
        (total[total.length - 1].val - total[0].val) * 1000 / (times[times.length - 1].val - times[0].val))));
    total.length = 0;
    times.length = 0;
}

function initCharts() {
    let create = (id, title, time, rtn, p2p) => {
        rtn[id] = [];
        p2p[id] = [];

        return new Chart(
            document.getElementById(id),
            {
                type: 'line',
                data: {
                    labels: time,
                    datasets: [
                        { label: 'rtn', data: rtn[id] },
                        { label: 'internet', data: p2p[id] }
                    ]
                },
                options: {
                    responsive: true,
                    animation: false,
                    elements: { point: {pointStyle: false} },
                    plugins: {
                        title: {
                            display: true,
                            text: title
                        },
                        legend: {
                            display: false
                        }
                    }
                }
            }
        );
    };

    jitterChart = create("chart_in_jitter", "jitter(ms)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    jbChart = create('chart_in_jb', "jitter buffer delay(ms)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    inkbpsChart = create("chart_in_kbps", "inbound bitrate(kbps)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    innackChart = create("chart_in_nack", "nack sent", dataset.time, dataset.data.rtn, dataset.data.p2p);
    lossChart = create("chart_in_loss", "loss ratio(%)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    infpsChart = create("chart_in_fps", "inbound fps", dataset.time, dataset.data.rtn, dataset.data.p2p);
    rttChart = create("chart_in_rtt", "round trip time(ms)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    widthChart = create("chart_out_width", "sending resolution width(px)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    heightChart = create("chart_out_height", "sending resolution height(px)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    outfpsChart = create("chart_out_fps", "outbound fps", dataset.time, dataset.data.rtn, dataset.data.p2p);
    outnackChart = create("chart_out_nack", "nack received", dataset.time, dataset.data.rtn, dataset.data.p2p);
    outkbpsChart = create("chart_out_kbps", "outbound bitrate(kbps)", dataset.time, dataset.data.rtn, dataset.data.p2p);
    outbweChart  = create("chart_out_bwe", "outbound bwe(kbps)", dataset.time, dataset.data.rtn, dataset.data.p2p);
}

async function createTracks() {
    [localAudioTrack, localVideoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks(
        undefined,
        {
            encoderConfig: {frameRate: 30, bitrateMax: 1000, width: 1280, height: 720}, optimizationMode:"motion"
        });
    localVideoTrack.play("localVideo");
}

async function init() {
    let params = (new URL(document.location)).searchParams;
    if (!!params.get("type")) {
        console.log("m " + params.get("type"));
        if (params.get("type") == "charts") {
            Array.from(document.getElementsByClassName("video-box")).forEach((el) => {
                el.style.display = "none";
            });
            document.getElementById("container").style.maxWidth = "100%";
        } else if (params.get("type") == "bot") {
            Array.from(document.getElementsByTagName("canvas")).forEach((el) => {
                el.style.display = "none";
            });
            botmode = true;
        }
    }
    if (!!params.get("console") && params.get("console") == "1") {
        Array.from(document.getElementsByClassName("vc-switch")).forEach((el) => {
            el.dispatchEvent(new Event('click'));
        });
    }
    if (!!params.get("debug") && params.get("debug") == "1") {
        AgoraRTC.setParameter("SHOW_P2P_LOG",true);
    }
    if (!!params.get("int") && parseInt(params.get("int")) != NaN) {
        drawInterval = Math.max(1, Math.min(60, parseInt(params.get("int"))));
    }
    console.log("draw interval=" + drawInterval);
    if (!!params.get("call")) {
        console.log("call " + params.get("call"));
        document.getElementById("room").value = params.get("call");
        await call();
        return;
    }

    var initNo = randomNum(1000, 9999);
    document.getElementById('no').innerHTML = initNo.toString();

    await join(initNo.toString());
    await publish();
}

function randomNum(minNum, maxNum) {
    switch (arguments.length) {
        case 1:
            return parseInt(Math.random() * minNum + 1);
            break;
        case 2:
            return parseInt(Math.random() * (maxNum - minNum + 1) + minNum);
            break;
        default:
            return 0;
            break;
    }
}

async function join(channel) {

    let params = (new URL(document.location)).searchParams;
    var mode = "p2p";
    var appid = ""
    let p2puid, rtnuid;

    if (!params.get("appid")) {
        window.alert("please fill appid in url params");
        return;
    } else {
        appid = params.get("appid");
    }

    if (channel == "") {
        channel = "p2p_demo";
    }

    AgoraRTC.setParameter("AP_AREA", false);

    clientP2P = AgoraRTC.createClient({mode: mode, codec: "vp8", role: "host"});
    clientRTN = AgoraRTC.createClient({mode: "live", codec: "vp8", role: "host"});

    clientP2P.timerTriggers = 0;
    clientRTN.timerTriggers = 0;
    clientP2P.name = "p2p";
    clientRTN.name = "rtn";
    clientP2P.stats = { "in": {}, "out": {} };
    clientRTN.stats = { "in": {}, "out": {} };

    clientP2P.setP2PTransport("default");
    //clientRTN.setP2PTransport("sd-rtn");

    rtcOptions = {};
    rtcOptions.appid = appid;
    rtcOptions.channel = channel;

    for (const key in rtcOptions)
        console.log("[webapp] rtc options:" + key + " => " + rtcOptions[key] + " (" + typeof(rtcOptions[key]) + ")");

    clientP2P.on("user-published", handleUserPublished);
    clientP2P.on("user-unpublished", handleUserUnpublished);
    clientP2P.on("user-joined", handleUserJoined);

    clientRTN.on("user-published", handleUserPublishedRTN);
    clientRTN.on("user-unpublished", handleUserUnpublished);
    clientRTN.on("user-joined", handleUserJoined);

    try {
        await Promise.all([clientP2P.join(rtcOptions.appid, rtcOptions.channel, rtcOptions.token || null, null),
                           clientRTN.join(rtcOptions.appid, rtcOptions.channel + "_rtn", rtcOptions.token || null, null)])
            .then((values) => {});
    } catch (e) {
        console.error("[webapp] join() failed, reason: " + e);
    }
}

async function subscribe(user, mediaType, renderID, client) {
    const uid = user.uid;

    // subscribe to a remote user
    try {
        await client.subscribe(user, mediaType);
    } catch (e) {
        console.error("[webapp] subscribe() failed, reason: " + e);
    }

    if (mediaType === 'video') {
        user.videoTrack.play(renderID);

        if (botmode) return;

        let timer = setInterval(
            () => {
                client.timerTriggers++;

                if (client.name == "p2p" && (client._p2pChannel.recvConnection == undefined || client._p2pChannel.sendConnection == undefined))
                    return;
                else if (client.name == "rtn" && (client._p2pChannel.connection == undefined || client._p2pChannel.connection.peerConnection == undefined))
                    return;

                let stats;
                if (client.name == "p2p") {
                    stats = [client._p2pChannel.recvConnection.peerConnection.getStats(),
                             client._p2pChannel.sendConnection.peerConnection.getStats()];
                } else {
                    stats = [client._p2pChannel.connection.peerConnection.getStats(),
                             client._p2pChannel.connection.peerConnection.getStats()];
                }

                Promise.all(stats)
                    .then((values) => {
                        let output = "";

                        let inbound = "------------------<br>";
                        [...values[0].entries()].forEach((e) => {
                            if (e.length > 1 && e[1].type == "inbound-rtp") {
                                for (const [key, value] of Object.entries(e[1])) {
                                    inbound += `${key}: ${value} <br>`;
                                    report(client, "in", key, value, e[1].timestamp);
                                }
                            }
                        })
                        output += inbound;

                        let remoteOut = "-------------------<br>";
                        [...values[1].entries()].forEach((e) => {
                            if (e.length > 1 && e[1].type == "remote-inbound-rtp") {
                                for (const [key, value] of Object.entries(e[1])) {
                                    remoteOut += `${key}: ${value} <br>`;
                                    report(client, "in", key, value, e[1].timestamp);
                                }
                            }
                        })
                        output += remoteOut;

                        let outbound = "-------------------<br>";
                        [...values[1].entries()].forEach((e) => {
                            if (e.length > 1 && e[1].type == "outbound-rtp" && e[1].frameHeight > 0) {
                                for (const [key, value] of Object.entries(e[1])) {
                                    outbound += `${key}: ${value} <br>`;
                                    report(client, "out", key, value, e[1].timestamp);
                                }
                            }
                        })
                        output += "<br>" + outbound;

                        let cp = "-------------------<br>";
                        [...values[1].entries()].forEach((e) => {
                            if (e.length > 1 && e[1].type == "candidate-pair") {
                                for (const [key, value] of Object.entries(e[1])) {
                                    cp += `${key}: ${value} <br>`;
                                    if (key == "availableOutgoingBitrate")
                                    report(client, "out", key, value, e[1].timestamp);
                                }
                            }
                        })
                        output += "<br>" + cp;

                        document.getElementById(renderID + "Stats").innerHTML = output;
                    });
            },
            250,
        );

        if (renderID === 'remoteVideo') {
            clientP2PTimer = timer;
        } else {
            clientRTNTimer = timer;
        }
    }
    if (mediaType === 'audio') {
        user.audioTrack.play();
    }
}

function handleUserPublished(user, mediaType, renderID) {
    answer();
    subscribe(user, mediaType, 'remoteVideo', clientP2P);
}

function handleUserPublishedRTN(user, mediaType, renderID) {
    answer();
    subscribe(user, mediaType, 'remoteVideo2', clientRTN);
}

function handleUserUnpublished(user, mediaType) {
}

function handleUserJoined(user) {
}

async function publish() {
    await clientP2P.publish([localVideoTrack]);
    await clientRTN.publish([localVideoTrack]);
}

function leave() {
    clearInterval(clientP2PTimer);
    clearInterval(clientRTNTimer);
    document.getElementById("remoteVideoStats").innerHTML = "";
    document.getElementById("remoteVideo2Stats").innerHTML = "";

    if (clientP2P != undefined)
        clientP2P.leave();
    if (clientRTN != undefined)
        clientRTN.leave();
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const callButton = document.getElementById('callButton');
const hangupButton = document.getElementById('hangupButton');
callButton.disabled = false;
hangupButton.disabled = true;
callButton.addEventListener('click', call);
hangupButton.addEventListener('click', hangup);

async function call() {

    document.getElementById('desc').innerHTML = 'hangup or call a number ';
    leave();
    await join(document.getElementById("room").value);
    await publish();

    callButton.disabled = true;
    hangupButton.disabled = false;
}

async function answer() {
    callButton.disabled = true;
    hangupButton.disabled = false;
}

async function hangup() {
    document.getElementById('desc').innerHTML = 'Your phone number is <b id="no"></b> or call a number &nbsp;';
    leave();
    init();

    hangupButton.disabled = true;
    callButton.disabled = false;
}

async function report(client, direction, key, val, ts) {
    if (key == "jitter" ||
        key == "jitterBufferDelay" || key == "jitterBufferEmittedCount" ||
        key == "bytesReceived"||
        key == "nackCount" ||
        key == "packetsLost" || key == "packetsReceived" ||
        key == "framesReceived" ||
        key == "frameHeight" || key == "frameWidth" ||
        key == "framesSent" ||
        key == "bytesSent" ||
        key == "totalRoundTripTime" || key == "roundTripTimeMeasurements" ||
        key == "availableOutgoingBitrate"
       ) {
        if (client.stats[direction][key] == undefined)
            client.stats[direction][key] = [];
        client.stats[direction][key].push({val: val, time: ts});
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


