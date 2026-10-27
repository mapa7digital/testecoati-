import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MindARThree } from 'mindar-image-three';

// ==========================================================================
// Visualizador 3D + Realidade Aumentada para o modelo quati.fbx
//
// A RA agora usa MindAR (rastreamento de IMAGEM, via câmera). O quati aparece
// em cima da imagem-alvo (alvo.jpg), que pode ser impressa ou exibida em
// outra tela. O arquivo targets.mind é a versão "compilada" dessa imagem —
// se trocar a imagem, gere outro .mind em
// https://hiukim.github.io/mind-ar-js-doc/tools/compile
//
// A animação de entrada (deslizamento) do modelo "de mesa" foi retirada
// daqui e vive em ./modules/entranceAnimation.js — veja aquele arquivo se
// quiser reativá-la.
// ==========================================================================

// Imagem-alvo (para o usuário imprimir ou exibir em outra tela) e o arquivo
// compilado do MindAR gerado a partir dela.
const AR_TARGET_IMAGE_URL = './alvo.jpg';
const AR_TARGET_MIND_URL = './targets.mind';
// Tamanho do quati na RA em relação à LARGURA da imagem-alvo (1 = mesma largura)
const AR_MODEL_SCALE = 0.9;

const infoEl = document.getElementById('info');
const loadingEl = document.getElementById('loading');
const arContainer = document.getElementById('ar-button-container');
const arWarning = document.getElementById('ar-warning');

const DEFAULT_INFO_TEXT = 'Quati 3D — arraste para girar, scroll para zoom';
const AR_INFO_TEXT = 'Aponte a câmera para a imagem do tubarão para ver o quati sobre ela.';

// ==========================================================================
// ---------- MOVIMENTO: rotação automática e eixo vertical do modelo ----------
// Toda a lógica de "movimento" do modelo fica concentrada aqui, separada do
// resto do arquivo, para ficar fácil de achar e ajustar.
// ==========================================================================

// Rotação automática (gira sozinha, além do arraste manual do OrbitControls
// no modo "de mesa"). Isso é aplicado tanto no modelo "de mesa" quanto no
// modelo da RA, no loop de animação lá embaixo.
const MODEL_AUTO_ROTATE = true;      // true = o quati gira sozinho; false = fica parado até o usuário arrastar
const MODEL_ROTATION_SPEED = 0.6;    // radianos por segundo (≈ 34°/s) — velocidade da rotação automática
const MODEL_ROTATION_AXIS = 'y';     // eixo da rotação automática: 'x', 'y' ou 'z'

// Eixo vertical (Y) do modelo, usado para apoiar o quati sobre o marcador
// na RA. Alguns FBX são exportados com o eixo Y espelhado/invertido em
// relação ao que o three.js espera (Y crescendo para cima). Se o quati
// aparecer de cabeça para baixo, flutuando ou afundado no marcador, alterne
// este valor — é usado lá em setupARScene().
const INVERT_MODEL_Y = true;

// Relógio para calcular a rotação automática em radianos/segundo "de
// verdade", independente da taxa de quadros (FPS) do dispositivo.
const clock = new THREE.Clock();

// ==========================================================================
// ---------- Modo "de mesa" (visualização normal, fora da RA) ----------
// ==========================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d0f);

const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.01,
    2000
);
camera.position.set(0, 0, 150);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Controles de mouse/touch (arrastar para girar, scroll para zoom) - só
// fazem sentido no modo "de mesa", fora da sessão de RA.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Luzes do modo "de mesa"
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
directionalLight.position.set(1, 1, 1);
scene.add(directionalLight);

const backLight = new THREE.DirectionalLight(0xffffff, 0.4);
backLight.position.set(-1, -1, -1);
scene.add(backLight);

// ---------- Estado do modelo carregado ----------
// modelObject é um "wrapper" (THREE.Group) que contém o objeto do FBX como
// filho. O objeto do FBX é centralizado dentro desse wrapper (equivalente ao
// que era feito com geometry.translate() no STL), enquanto o próprio
// wrapper fica em (0,0,0) — assim dá para reaproveitar o wrapper tanto no
// modo "de mesa" quanto (clonado) na RA, aplicando escala/posição/rotação
// nele sem bagunçar a centralização interna.
let modelObject = null;
let modelSize = null; // THREE.Vector3 com as dimensões do bounding box
let modelMaxDim = 1;
let previewMesh = null; // wrapper do modo "de mesa" (guardado para a rotação automática)

// Material usado como fallback para malhas do FBX que não trouxerem material
// próprio embutido no arquivo.
const FALLBACK_MATERIAL = new THREE.MeshStandardMaterial({
    color: 0xa9835a,
    metalness: 0.05,
    roughness: 0.85
});

// ---------- Carregamento do FBX ----------
const loader = new FBXLoader();

loader.load(
    './quati.fbx',
    (object) => {
        object.traverse((child) => {
            if (child.isMesh && !child.material) {
                child.material = FALLBACK_MATERIAL;
            }
        });

        // Centraliza o quati: mede a caixa delimitadora do objeto recém
        // carregado (ainda na origem) e desloca o próprio objeto para que
        // seu centro fique em (0,0,0).
        const box = new THREE.Box3().setFromObject(object);
        const center = new THREE.Vector3();
        box.getCenter(center);
        object.position.sub(center);

        modelSize = new THREE.Vector3();
        box.getSize(modelSize);
        modelMaxDim = Math.max(modelSize.x, modelSize.y, modelSize.z) || 1;

        // O objeto centralizado vira filho de um wrapper — é esse wrapper
        // que manipulamos (posição/escala/rotação) daqui pra frente.
        modelObject = new THREE.Group();
        modelObject.add(object);

        // Modelo "de mesa" - aparece direto centralizado. A rotação
        // automática (se MODEL_AUTO_ROTATE estiver true) é aplicada no loop
        // de animação lá embaixo; não há mais animação de entrada por
        // deslizamento.
        previewMesh = modelObject;
        camera.position.set(0, 0, modelMaxDim * 2);
        controls.target.set(0, 0, 0);
        controls.update();
        scene.add(previewMesh);

        if (loadingEl) loadingEl.style.display = 'none';
        checkARSupport();
    },
    (xhr) => {
        if (xhr.total && loadingEl) {
            const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
            loadingEl.textContent = `Carregando modelo... ${pct}%`;
        }
    },
    (error) => {
        console.error('Erro ao carregar o FBX:', error);
        if (loadingEl) {
            loadingEl.textContent = 'Erro ao carregar quati.fbx. Verifique se o arquivo está na mesma pasta.';
        }
    }
);

// ==========================================================================
// ---------- Realidade Aumentada (AR.js, marcador Hiro) ----------
// ==========================================================================
// ==========================================================================
// ---------- Realidade Aumentada (MindAR, rastreamento de imagem) ----------
// ==========================================================================
let arActive = false;
let mindar = null;       // instância do MindARThree
let arAnchor = null;     // âncora presa à imagem-alvo
let arMesh = null;       // wrapper do quati dentro da RA (guardado para a rotação automática)
let arContainer3D = null; // div onde o MindAR coloca vídeo + canvas

function showWarning(msg) {
    if (!arWarning) return;
    arWarning.style.display = 'block';
    arWarning.textContent = msg;
}

function describeError(e) {
    if (!e) return 'erro desconhecido';
    return `${e.name || 'Error'}: ${e.message || e}`;
}

// Verificação de suporte em etapas, cada uma com uma mensagem ESPECÍFICA -
// evita deixar o usuário travado numa tela de carregamento sem saber por quê.
async function checkARSupport() {
    if (!window.isSecureContext) {
        showWarning(
            `A RA por câmera precisa de um contexto seguro (HTTPS ou localhost). Esta página ` +
            `foi carregada via "${location.protocol}//${location.host}", que não é seguro. ` +
            `Sirva os arquivos com HTTPS (ex.: um túnel como ngrok/Cloudflare Tunnel, ou ` +
            `hospedagem com certificado válido).`
        );
        return;
    }

    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
        showWarning(
            'Este navegador não expõe acesso à câmera (getUserMedia indisponível). Tente um ' +
            'navegador atualizado, como Chrome, Safari ou Firefox.'
        );
        return;
    }

    createARButton();
}

function createARButton() {
    const button = document.createElement('button');
    button.id = 'ar-button';
    button.textContent = 'Ver em RA';
    arContainer.appendChild(button);

    const hint = document.createElement('a');
    hint.id = 'ar-marker-link';
    hint.href = AR_TARGET_IMAGE_URL;
    hint.target = '_blank';
    hint.rel = 'noopener';
    hint.textContent = 'Ver imagem-alvo (imprima ou abra em outra tela)';
    arContainer.appendChild(hint);

    arContainer.classList.add('ready');

    button.addEventListener('click', () => {
        if (arActive) {
            stopARSession(button);
        } else {
            startARSession(button);
        }
    });
}

async function startARSession(button) {
    button.disabled = true;
    button.textContent = 'Iniciando câmera...';
    if (arWarning) arWarning.style.display = 'none';

    try {
        setupARScene();
        await mindar.start(); // pede a câmera, carrega o targets.mind e inicia o rastreamento
    } catch (err) {
        console.error('Falha ao iniciar a RA:', err);
        const msg = 'Não foi possível iniciar a RA: ' + describeError(err);
        if (infoEl) infoEl.textContent = msg;
        showWarning(msg);
        teardownAR();
        button.disabled = false;
        button.textContent = 'Ver em RA';
        return;
    }

    arActive = true;
    button.disabled = false;
    button.textContent = 'Sair da RA';

    // Modo "de mesa" some enquanto a RA está ativa
    renderer.domElement.style.display = 'none';
    controls.enabled = false;
    if (infoEl) infoEl.textContent = AR_INFO_TEXT;
}

function stopARSession(button) {
    arActive = false;
    const btn = button || document.getElementById('ar-button');
    if (btn) btn.textContent = 'Ver em RA';

    teardownAR();

    renderer.domElement.style.display = 'block';
    controls.enabled = true;
    if (infoEl) infoEl.textContent = DEFAULT_INFO_TEXT;
}

// Para a câmera (apaga o LED) e descarta tudo para a próxima sessão começar limpa.
function teardownAR() {
    if (mindar) {
        try { mindar.stop(); } catch (e) { console.warn(e); }
        try { mindar.renderer.dispose(); } catch (e) { /* ignora */ }
    }
    if (arContainer3D) {
        arContainer3D.querySelectorAll('video').forEach((v) => {
            const stream = v.srcObject;
            if (stream) stream.getTracks().forEach((t) => t.stop());
        });
        arContainer3D.remove();
    }
    mindar = null;
    arAnchor = null;
    arMesh = null;
    arContainer3D = null;
}

function setupARScene() {
    // Contêiner onde o MindAR coloca o vídeo da câmera e o canvas 3D.
    // z-index 1: fica abaixo dos botões (que usam z-index 10+).
    arContainer3D = document.createElement('div');
    arContainer3D.style.cssText = 'position:fixed;inset:0;z-index:1;overflow:hidden;background:#000;';
    document.body.appendChild(arContainer3D);

    mindar = new MindARThree({
        container: arContainer3D,
        imageTargetSrc: AR_TARGET_MIND_URL,
        uiLoading: 'no',
        uiScanning: 'no',
        uiError: 'no'
    });

    const { scene: arScene } = mindar;
    arScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2));
    const arDirLight = new THREE.DirectionalLight(0xffffff, 1);
    arDirLight.position.set(1, 1, 1);
    arScene.add(arDirLight);

    // O quati fica dentro de arAnchor.group; o MindAR atualiza a posição desse
    // grupo a cada frame para acompanhar a imagem-alvo.
    arAnchor = mindar.addAnchor(0);

    if (modelObject) {
        // No MindAR a imagem fica no plano XY e o "para cima" é o eixo Z
        // (diferente do AR.js/Hiro, onde era o Y). Por isso o quati entra num
        // grupo "em pé" girado 90° em X; a rotação automática continua sendo
        // aplicada só no arMesh, dentro desse grupo.
        const upright = new THREE.Group();
        upright.rotation.x = Math.PI / 2;
        arAnchor.group.add(upright);

        arMesh = modelObject.clone(true);
        const scale = AR_MODEL_SCALE / modelMaxDim;
        arMesh.scale.setScalar(scale);

        // Eixo vertical: apoiar o quati sobre a imagem (ver INVERT_MODEL_Y no topo).
        const verticalOffset = (modelSize.y / 2) * scale;
        arMesh.position.y = INVERT_MODEL_Y ? -verticalOffset : verticalOffset;

        upright.add(arMesh);
    }

    // Avisos quando a imagem-alvo é encontrada / perdida
    arAnchor.onTargetFound = () => {
        if (infoEl) infoEl.textContent = 'Imagem encontrada!';
    };
    arAnchor.onTargetLost = () => {
        if (infoEl) infoEl.textContent = AR_INFO_TEXT;
    };
}

// ---------- Loop de renderização ----------
function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();

    // ---------- MOVIMENTO: rotação automática do modelo ----------
    // Gira o mesh que está visível no momento (o de mesa ou o da RA) no
    // eixo configurado em MODEL_ROTATION_AXIS, lá no topo do arquivo. Fica
    // independente do arraste manual do OrbitControls, que continua
    // funcionando normalmente por cima disso no modo "de mesa".
    if (MODEL_AUTO_ROTATE) {
        const activeMesh = arActive ? arMesh : previewMesh;
        if (activeMesh) {
            activeMesh.rotation[MODEL_ROTATION_AXIS] += MODEL_ROTATION_SPEED * delta;
        }
    }

    if (arActive) {
        // O rastreamento roda dentro do MindAR; aqui só desenhamos a cena.
        if (mindar) mindar.renderer.render(mindar.scene, mindar.camera);
    } else {
        controls.update();
        renderer.render(scene, camera);
    }
}
animate();

// ---------- Responsividade (modo "de mesa") ----------
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ==========================================================================
// ---------- QR Code de acesso rápido ----------
// ==========================================================================
let qrRendered = false;

function renderQRCode() {
    const target = document.getElementById('qrcode');
    if (!target || typeof QRCode === 'undefined') return;
    target.innerHTML = '';
    new QRCode(target, {
        text: window.location.href,
        width: 180,
        height: 180,
        colorDark: '#0b0d0f',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
    const urlEl = document.getElementById('qr-url');
    if (urlEl) urlEl.textContent = window.location.href;
    qrRendered = true;
}

const qrToggle = document.getElementById('qr-toggle');
const qrPanel = document.getElementById('qr-panel');
if (qrToggle && qrPanel) {
    qrToggle.addEventListener('click', () => {
        const isOpen = qrPanel.classList.toggle('open');
        if (isOpen && !qrRendered) renderQRCode();
    });
    const qrClose = document.getElementById('qr-close');
    if (qrClose) qrClose.addEventListener('click', () => qrPanel.classList.remove('open'));
}
