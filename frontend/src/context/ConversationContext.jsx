import { createContext, useContext, useReducer } from 'react';

const ConversationContext = createContext(null);

const initialState = {
  conversationId: null,
  messages: [],
  isLoading: false,
  extractedData: null,
  meddraData: null,
  fieldStatus: null,
  completenessScore: null,
  isReportReady: false,
  isEmergency: false,
  userType: 'patient',
  language: 'hi-IN',
  isAnonymous: true,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_CONVERSATION_ID': return { ...state, conversationId: action.payload };
    case 'SET_MESSAGES': return { ...state, messages: action.payload };
    case 'ADD_MESSAGE': return { ...state, messages: [...state.messages, action.payload] };
    case 'UPDATE_LAST_MESSAGE': {
      const msgs = [...state.messages];
      if (msgs.length > 0) msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: action.payload, isLoading: false };
      return { ...state, messages: msgs };
    }
    case 'UPDATE_VOICE_RESPONSE': {
      const msgs = [...state.messages];
      if (msgs.length > 1) {
        msgs[msgs.length - 2] = { ...msgs[msgs.length - 2], content: action.payload.transcript, isLoading: false };
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: action.payload.message, isLoading: false };
      }
      return { ...state, messages: msgs };
    }
    case 'SET_LOADING': return { ...state, isLoading: action.payload };
    case 'SET_EXTRACTED_DATA': return { ...state, extractedData: action.payload };
    case 'SET_MEDDRA_DATA': return { ...state, meddraData: action.payload };
    case 'SET_FIELD_STATUS': return { ...state, fieldStatus: action.payload };
    case 'SET_COMPLETENESS': return { ...state, completenessScore: action.payload };
    case 'SET_REPORT_READY': return { ...state, isReportReady: action.payload };
    case 'SET_EMERGENCY': return { ...state, isEmergency: action.payload };
    case 'SET_USER_TYPE': return { ...state, userType: action.payload };
    case 'SET_LANGUAGE': return { ...state, language: action.payload };
    case 'SET_ANONYMOUS': return { ...state, isAnonymous: action.payload };
    case 'RESET': return { ...initialState };
    default: return state;
  }
}

export function ConversationProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <ConversationContext.Provider value={{ state, dispatch }}>
      {children}
    </ConversationContext.Provider>
  );
}

export const useConversationContext = () => useContext(ConversationContext);
