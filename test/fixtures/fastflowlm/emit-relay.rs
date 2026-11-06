// Run against the desktop app's compiled Rust library. See README.md.
use app_lib::core::atomic_core::host_step::{HostStep, ReceiptOutcome};
use app_lib::core::atomic_core::relay::{SseFrame, SseParser, EVENT_PREFIX};

#[test]
fn dump_fixtures() {
    let wire = include_str!("control-v1.json");
    let mut parser = SseParser::new();
    let sample = SseFrame {
        data: wire.to_owned(),
        ..Default::default()
    }
    .payload();
    let operation = &sample["operation"];
    let input = format!("id: owner:1\nevent: fastflowlm:operation\ndata: {operation}\n\n");
    let frames = parser.push(input.as_bytes()).unwrap();
    let [frame] = frames.as_slice() else {
        panic!("expected one SSE frame")
    };
    let name = frame.event.as_deref().unwrap();
    let payload = frame.payload();
    assert_eq!(&payload, operation);
    let step = HostStep::from_operation(&payload).expect("recoverable privileged step");
    let receipt = step.receipt(ReceiptOutcome::Completed, "receipt-1");
    assert_eq!(receipt, sample["receipt"]);
    let mut envelope = frame.payload();
    envelope["data"] = envelope.take();
    envelope["receipt"] = receipt;
    envelope["id"] = frame.id.clone().unwrap().into();
    envelope["event"] = name.into();
    envelope["desktop_event"] = format!("{EVENT_PREFIX}{name}").into();
    std::fs::write(
        "test/fixtures/fastflowlm/relay-event.json",
        format!("{envelope:#}\n"),
    )
    .unwrap();
}
