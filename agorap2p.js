// p2p

var clientP2P;
var clientRTN;
var clientP2PTimer;
var clientRTNTimer;

var localAudioTrack, localVideoTrack;

AgoraRTC.setParameter("P2P", true);
onload();

async function onload() {
    await createTracks();
    await init();
}

async function createTracks() {
    [localAudioTrack, localVideoTrack] = await AgoraRTC.createMicrophoneAndCameraTracks(
        undefined,
        {
            encoderConfig: {frameRate: 30, bitrateMax: 2000, width: 1280, height: 720}, optimizationMode:"motion"
        });
    localVideoTrack.play("localVideo");
}

async function init() {
    let params = (new URL(document.location)).searchParams;
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

    /*
    AgoraRTC.setParameter("WEBCS_DOMAIN", [
        "http.ap.staging-1-aws.myagoralab.com",
        "http.ap.staging-1-ali.myagoralab.com",
    ]);
    AgoraRTC.setParameter("WEBCS_DOMAIN_BACKUP_LIST", [
        "http.ap.staging-1-aws.myagoralab.com",
        "http.ap.staging-1-ali.myagoralab.com",
    ]);
    AgoraRTC.setParameter("GATEWAY_ADDRESS", [{"ip":"101.96.145.71","port":18888}]);
    AgoraRTC.setParameter("TURN_DOMAIN", "edge.staging-1-aws.myagoralab.com");
    */
    AgoraRTC.setParameter("AP_AREA", false);

    clientP2P = AgoraRTC.createClient({mode: mode, codec: "vp9", role: "host"});
    clientRTN = AgoraRTC.createClient({mode: mode, codec: "vp9", role: "host"});

    clientP2P.setP2PTransport("default");
    clientRTN.setP2PTransport("sd-rtn");

    rtcOptions = {};
    rtcOptions.appid = appid;
    rtcOptions.channel = channel;

    for (const key in rtcOptions)
        console.log("[webapp] rtc options:" + key + " => " + rtcOptions[key] + " (" + typeof(rtcOptions[key]) + ")");
    // add event listener to play remote tracks when remote user publishs.
    clientP2P.on("user-published", handleUserPublished);
    clientP2P.on("user-unpublished", handleUserUnpublished);
    clientP2P.on("user-joined", handleUserJoined);

    clientRTN.on("user-published", handleUserPublishedRTN);
    clientRTN.on("user-unpublished", handleUserUnpublished);
    clientRTN.on("user-joined", handleUserJoined);

    try {
        //p2puid = await clientP2P.join(rtcOptions.appid, rtcOptions.channel, rtcOptions.token || null, rtcOptions.uid || null);
        //rtnuid = await clientRTN.join(rtcOptions.appid, rtcOptions.channel + "_rtn", rtcOptions.token || null, rtcOptions.uid || null);
        await Promise.all([clientP2P.join(rtcOptions.appid, rtcOptions.channel, rtcOptions.token || null, null),
                           clientRTN.join(rtcOptions.appid, rtcOptions.channel + "_rtn", rtcOptions.token || null, null)])
            .then((values) => {});
    } catch (e) {
        console.error("[webapp] join() failed, reason: " + e);
    }
    //console.log("[webapp] join channel " + rtcOptions.channel + "with uid=" + p2puid + " (" + typeof(p2puid) + ")");
    //console.log("[webapp] join channel " + rtcOptions.channel + "_rtn with uid=" + rtnuid + " (" + typeof(rtnuid) + ")");
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

        let timer = setInterval(
            () => {
                let output = "";
                for (const [key, value] of Object.entries(user.videoTrack.getStats())) {
                    output += `${key}: ${value} <br>`;
                }
                document.getElementById(renderID + "Stats").innerHTML = output;
            },
            1000,
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

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


