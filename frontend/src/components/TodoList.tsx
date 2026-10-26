import React, { useState, useEffect } from 'react';
import { todoApi, Todo } from '../services/todoApi';
import { createLogger } from '../logging/logger';
import './TodoList.css';

const log = createLogger('TodoList');

export const TodoList: React.FC = () => {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState('');
  const [trace, setTrace] = useState<any[]>([]);
  const [stats, setStats] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'todos' | 'trace' | 'stats'>('todos');
  const [loading, setLoading] = useState(false);
  const [totalTodos, setTotalTodos] = useState(0);
  const [lastResponseTime, setLastResponseTime] = useState(0);

  useEffect(() => {
    loadTodos();
  }, []);

  const loadTodos = async () => {
    setLoading(true);
    try {
      const result = await todoApi.getTodos();
      setTodos(result.data);
      setTotalTodos(result.count);
      setLastResponseTime(result.responseTime);
    } catch (error) {
      log.error('Erro ao carregar todos', { error });
    }
    setLoading(false);
  };

  const handleAddTodo = async () => {
    if (input.trim()) {
      try {
        await todoApi.createTodo(input);
        setInput('');
        loadTodos();
      } catch (error) {
        log.error('Erro ao criar todo', { error });
      }
    }
  };

  const handleToggle = async (id: string, completed: boolean) => {
    try {
      await todoApi.updateTodo(id, !completed);
      loadTodos();
    } catch (error) {
      log.error('Erro ao atualizar todo', { error, context: { todoId: id } });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await todoApi.deleteTodo(id);
      loadTodos();
    } catch (error) {
      log.error('Erro ao deletar todo', { error, context: { todoId: id } });
    }
  };

  const handleShowTrace = async () => {
    try {
      const logs = await todoApi.getTrace();
      setTrace(logs);
    } catch (error) {
      log.error('Erro ao buscar trace', { error });
    }
  };

  const handleShowStats = async () => {
    try {
      const data = await todoApi.getStats();
      setStats(data);
    } catch (error) {
      log.error('Erro ao buscar stats', { error });
    }
  };

  const completedCount = todos.filter(t => t.completed).length;

  return (
    <div className="todo-container">
      <div className="todo-header">
        <h1>📝 To-do List Manager</h1>
        <p>Gerencie suas tarefas com rastreamento completo</p>
      </div>

      <div className="stats-bar">
        <div className="stat">
          <span className="stat-label">Total</span>
          <span className="stat-value">{totalTodos}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Concluídas</span>
          <span className="stat-value">{completedCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Pendentes</span>
          <span className="stat-value">{totalTodos - completedCount}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Tempo Resposta</span>
          <span className="stat-value">{lastResponseTime}ms</span>
        </div>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'todos' ? 'active' : ''}`}
          onClick={() => setActiveTab('todos')}
        >
          Tarefas
        </button>
        {/*<button
          className={`tab ${activeTab === 'trace' ? 'active' : ''}`}
          onClick={() => setActiveTab('trace')}
        >
          Trace
        </button>
        <button
          className={`tab ${activeTab === 'stats' ? 'active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          Estatísticas
        </button>*/}
      </div>

      {activeTab === 'todos' && (
        <div className="todo-section">
          <div className="input-group">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleAddTodo()}
              placeholder="Adicionar nova tarefa..."
              className="todo-input"
            />
            <button onClick={handleAddTodo} className="btn btn-primary">
              Adicionar
            </button>
          </div>

          {loading ? (
            <p className="loading">Carregando...</p>
          ) : todos.length === 0 ? (
            <p className="empty">Nenhuma tarefa. Crie uma nova!</p>
          ) : (
            <ul className="todo-list">
              {todos.map((todo) => (
                <li key={todo._id} className={`todo-item ${todo.completed ? 'completed' : ''}`}>
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={() => handleToggle(todo._id, todo.completed)}
                    className="todo-checkbox"
                  />
                  <span className="todo-title">{todo.title}</span>
                  <button
                    onClick={() => handleDelete(todo._id)}
                    className="btn btn-danger btn-small"
                  >
                    Deletar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/*{activeTab === 'trace' && (
        <div className="trace-section">
          <button onClick={handleShowTrace} className="btn btn-primary">
            Carregar Trace
          </button>
          {trace.length > 0 && (
            <div className="trace-container">
              <h3>Histórico de Requisições ({trace.length})</h3>
              <pre className="trace-content">
                {JSON.stringify(trace, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}*/}

      {/*{activeTab === 'stats' && (
        <div className="stats-section">
          <button onClick={handleShowStats} className="btn btn-primary">
            Carregar Estatísticas
          </button>
          {stats.length > 0 && (
            <div className="stats-container">
              <h3>Requisições por Ação</h3>
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Ação</th>
                    <th>Quantidade</th>
                    <th>Tempo Médio</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((stat) => (
                    <tr key={stat._id}>
                      <td>{stat._id}</td>
                      <td>{stat.count}</td>
                      <td>{Math.round(stat.avgResponseTime ?? 0)}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}*/}
    </div>
  );
};
