// p2p

var client;
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
    var mode = "rtc";
    var appid = ""

    if (!params.get("appid")) {
        window.alert("please fill appid in url params");
        return;
    } else {
        appid = params.get("appid");
    }

    if (channel == "") {
        channel = "p2p_demo";
    }

    client = AgoraRTC.createClient({mode: mode, codec: "vp9"});
    rtcOptions = {};
    rtcOptions.appid = appid;
    rtcOptions.channel = channel;

    for (const key in rtcOptions)
        console.log("[webapp] rtc options:" + key + " => " + rtcOptions[key] + " (" + typeof(rtcOptions[key]) + ")");
    // add event listener to play remote tracks when remote user publishs.
    client.on("user-published", handleUserPublished);
    client.on("user-unpublished", handleUserUnpublished);
    client.on("user-joined", handleUserJoined);
    try {
        rtcOptions.uid = await client.join(rtcOptions.appid, rtcOptions.channel, rtcOptions.token || null, rtcOptions.uid || null);
    } catch (e) {
        console.error("[webapp] join() failed, reason: " + e);
    }
    console.log("[webapp] join channel with uid=" + rtcOptions.uid + " (" + typeof(rtcOptions.uid) + ")");
}

async function subscribe(user, mediaType) {
    const uid = user.uid;

    // subscribe to a remote user
    try {
        await client.subscribe(user, mediaType);
    } catch (e) {
        console.error("[webapp] subscribe() failed, reason: " + e);
    }

    if (mediaType === 'video') {
        user.videoTrack.play('remoteVideo');
    }
    if (mediaType === 'audio') {
        user.audioTrack.play();
    }
}

function handleUserPublished(user, mediaType) {
    answer();
    subscribe(user, mediaType);
}

function handleUserUnpublished(user, mediaType) {
}

function handleUserJoined(user) {
}

async function publish() {
    await client.publish([localVideoTrack, localAudioTrack]);
}

function leave() {
    client.leave();
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


