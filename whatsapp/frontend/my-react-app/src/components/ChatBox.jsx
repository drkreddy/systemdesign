import React, { useEffect, useState, useRef } from 'react';

function ChatBox({ label, placeholder }) {

    // 1. Initialize state to hold the text box value
    const [text, setText] = useState('');
    const [name, setName] = useState('');
    const [nameEditMode,setNameEditMode] = useState(true);
    const [direct, setDirect] = useState(false);
    const [toName, setToName] = useState('');
    const [messages, setMessages] = useState([]);
    const [status, setStatus] = useState('Connecting...');


    const socketRef = useRef(null);
    const messagesEndRef = useRef(null);

    useEffect(() => {
        const ws = new WebSocket('ws://localhost:5000/chat');
        socketRef.current = ws;
        //connection opened
        ws.onopen = () => {
            setStatus('🟢 Connected');
        }

        // listen for incoming messages
        ws.onmessage = (event) => {
            console.log(event.data);
            const message= JSON.parse(event.data);
            message.isSender=false;
            setMessages((prevMessages)=> [...prevMessages, message]);
        }
        
        // Handle errors
        ws.onerror = (error) => {
            console.error('Websocker error:',error);
            setStatus('🔴 Connection Error');
        }

        // connection closed
        ws.onclose = ()=> {
            setStatus('❌ Disconnected');
        }
    
        //clean up connection when component unmounts
        return ()=> {
            if ( ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
    
    
    }, []);

    // 2. Update state whenever the user types
    const handleChange = (event) => {
        setText(event.target.value);
    };


    const sendMessage = (event) => {
        let message={ isSender: true, text: text, ts: getTime(), name, direct, to: direct ? toName : undefined };
        setMessages(messages => [...messages, message]);
        setText('');
        socketRef.current.send(JSON.stringify(message));
    };

    const getTime = () => {
        const date = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', {
            dateStyle: 'long',
            timeStyle: 'short'
        });
        return formatter.format(date); // July 15, 2026 at 3:10 PM
    }

    return (<>

        Hello I am chatbox
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <input disabled={!nameEditMode} type='text' value={name} onChange={ (e)=> setName(e.target.value)}/>
        {nameEditMode && <button onClick={(e)=>{
            setNameEditMode(false);
            if (name && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
                socketRef.current.send(JSON.stringify({ type: 'announce', name }));
            }
        }}>save</button>}
        <div style={styles.status}>{status}</div>
            <ul>
                {messages.map((msg, index) => (
                    <p key={index}> [{msg.ts}] :: {msg.name} :: {msg.text} </p>
                ))}
            </ul>
           <div> Direct? <input type='checkbox' checked={direct} onChange={(e) => setDirect(e.target.checked)}/>
           {direct && (
               <input type='text' placeholder="recipient's name" value={toName} onChange={(e) => setToName(e.target.value)}/>
           )}
           </div>

            <div style={{ display: 'flex', flexDirection: 'row', gap: '4px' }}>
                <input
                    type="text"
                    value={text}
                    onChange={handleChange}
                    placeholder={placeholder}
                    style={{ padding: '8px', fontSize: '16px', borderRadius: '4px', border: '1px solid #ccc' }}
                />
                <button onClick={sendMessage}>send</button>
            </div>
        </div>
    </>)
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', alignItems: 'center', backgroundColor: '#f0f2f5', height: '100vh', justifyContent: 'center', fontFamily: 'Arial, sans-serif' },
  status: { marginBottom: '10px', fontSize: '14px', fontWeight: 'bold' },
  chatBox: { width: '400px', height: '500px', backgroundColor: '#efeae2', borderRadius: '8px', boxShadow: '0 4px 10px rgba(0,0,0,0.1)', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  messagesContainer: { flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' },
  messageBubble: { padding: '8px 12px', borderRadius: '8px', maxWidth: '75%', fontSize: '14px', wordBreak: 'break-word', boxShadow: '0 1px 1px rgba(0,0,0,0.05)' },
  inputArea: { display: 'flex', padding: '10px', backgroundColor: '#f0f2f5', borderTop: '1px solid #ddd' },
  input: { flex: 1, padding: '10px 15px', borderRadius: '20px', border: '1px solid #ccc', outline: 'none' },
  button: { marginLeft: '10px', backgroundColor: '#00a884', color: 'white', border: 'none', borderRadius: '50%', width: '38px', height: '38px', cursor: 'pointer', fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }
};

export default ChatBox;