// 실제 시리얼 장치 backend(serialport 13). server/server.js만 불러온다 — app.js·테스트는 이 모듈을 import하지 않는다.
//
// 보드 재부팅 방지(ESP32 자동 리셋 회로는 DTR/RTS를 쓴다): hupcl false, rtscts false로 연다.
//   설치된 @serialport/bindings-cpp 13.0.0 src/serialport_win.cpp에서 확인: hupcl false → DTR_CONTROL_DISABLE,
//   rtscts false → RTS_CONTROL_DISABLE(둘 다 SetCommState). bindings 기본값은 hupcl true(DTR_CONTROL_ENABLE)라 명시해야 한다.
//   단, 포트를 여는 순간(CreateFile~SetCommState 사이)의 신호는 OS·USB 드라이버에 달려 있어 모든 환경에서 리셋이 없다고 보장하지 않는다.
// 연결할 때 보드에 아무것도 쓰지 않는다. lock true(기본)로 다른 프로그램과 포트를 함께 쓰지 않는다.

export const PC_BAUD = 115200; // 펌웨어 PC_BAUD

export async function loadSerialBackend() {
  const { SerialPort } = await import('serialport');
  return {
    list: () => SerialPort.list(),

    // handlers: { onData(buf), onClose(err|null) } — onClose는 열린 뒤의 끊김에만 부른다.
    open(path, { onData, onClose }) {
      return new Promise((resolve, reject) => {
        const port = new SerialPort({
          path,
          baudRate: PC_BAUD,
          autoOpen: false,
          hupcl: false,
          rtscts: false,
          lock: true,
        });
        let opened = false;
        let closedReported = false;
        const reportClose = (err) => {
          if (!opened || closedReported) return;
          closedReported = true;
          onClose(err ?? null);
        };
        port.on('data', (buf) => onData(buf));
        port.on('close', (err) => reportClose(err));
        port.on('error', (err) => {
          if (!port.isOpen) reportClose(err);
        });
        port.open((err) => {
          if (err) {
            reject(err);
            return;
          }
          opened = true;
          resolve({
            write: (text) => new Promise((res, rej) => {
              port.write(text, 'utf8', (e) => {
                if (e) rej(e);
                else port.drain((e2) => (e2 ? rej(e2) : res()));
              });
            }),
            close: () => new Promise((res) => {
              closedReported = true; // 스스로 닫는 것은 끊김으로 알리지 않는다
              if (!port.isOpen) {
                res();
                return;
              }
              port.close(() => res());
            }),
          });
        });
      });
    },
  };
}
