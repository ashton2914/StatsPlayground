use std::{io::{BufRead,BufReader,Read},path::{Path,PathBuf},process::{Child,Command,Stdio},sync::mpsc,time::{Duration,Instant}};
use serde_json::Value;

pub fn executable()->PathBuf {
    std::env::var_os("STATSPG_PROJECT_V5_HARNESS").map(PathBuf::from).unwrap_or_else(||std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("examples").join(if cfg!(windows){"project_persistence_v5.exe"}else{"project_persistence_v5"}))
}
fn command(path:&Path,scenario:&str,extra:&[&str])->Command {
    let mut command=Command::new(executable());command.args(["--scenario",scenario,"--path"]).arg(path).args(extra).stdout(Stdio::piped()).stderr(Stdio::piped());command
}
pub fn run(path:&Path,scenario:&str,extra:&[&str])->Value {
    let mut child=command(path,scenario,extra).spawn().expect("build the real project_persistence_v5 example first");let pid=child.id();
    let mut stdout=child.stdout.take().unwrap();let output=std::thread::spawn(move||{let mut bytes=vec![];stdout.read_to_end(&mut bytes).unwrap();bytes});
    let mut stderr=child.stderr.take().unwrap();let errors=std::thread::spawn(move||{let mut bytes=vec![];stderr.read_to_end(&mut bytes).unwrap();bytes});
    let deadline=Instant::now()+Duration::from_secs(if scenario=="seed"&&extra.contains(&"--tier"){120}else{30});
    let status=loop {if let Some(status)=child.try_wait().unwrap(){break status;}if Instant::now()>deadline{child.kill().unwrap();child.wait().unwrap();panic!("native scenario {scenario} timed out");}std::thread::sleep(Duration::from_millis(10));};
    let bytes=output.join().unwrap();let errors=errors.join().unwrap();assert!(status.success(),"native {scenario} failed: {}",String::from_utf8_lossy(&errors));
    let value:Value=serde_json::from_slice(&bytes).expect("one complete native JSON report");assert_eq!(value["processId"].as_u64(),Some(pid as u64));assert_ne!(pid,std::process::id(),"verification must run in another process");value
}
pub fn pause(path:&Path,scenario:&str,mutation:&str)->Child {pause_with(path,scenario,&["--mutation",mutation])}
pub fn pause_with(path:&Path,scenario:&str,extra:&[&str])->Child {
    let mut child=command(path,scenario,extra).spawn().expect("build the native crash example first");let stdout=child.stdout.take().unwrap();let (send,receive)=mpsc::channel();
    std::thread::spawn(move||{let mut line=String::new();let read=BufReader::new(stdout).read_line(&mut line);let _=send.send((read,line));});
    let event=match receive.recv_timeout(Duration::from_secs(20)){Ok((Ok(_),line))=>serde_json::from_str::<Value>(&line).expect("crash phase JSON"),other=>{let _=child.kill();let _=child.wait();panic!("native crash point unavailable: {other:?}");}};
    assert_eq!(event["event"],"crash-ready");assert_eq!(event["processId"].as_u64(),Some(child.id() as u64));child
}
pub fn kill(mut child:Child) {child.kill().expect("abruptly kill the owned fixture child");assert!(!child.wait().unwrap().success());}

pub fn rejected(path:&Path,scenario:&str,extra:&[&str])->String {
    let output=command(path,scenario,extra).output().expect("launch native rejection probe");
    assert!(!output.status.success(),"request must be rejected without opening a writable session");String::from_utf8(output.stderr).unwrap()
}
