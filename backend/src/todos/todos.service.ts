import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Todo } from './schemas/todo.schema';
import { RequestLog } from './schemas/request-log.schema';

@Injectable()
export class TodosService {
  private readonly logger = new Logger(TodosService.name);

  constructor(
    @InjectModel(Todo.name) private todoModel: Model<Todo>,
    @InjectModel(RequestLog.name) private logModel: Model<RequestLog>,
  ) {}

  async createTodo(title: string): Promise<Todo> {
    this.logger.log(`[SERVICE] Criando todo: ${title}`);
    const todo = new this.todoModel({ title, completed: false });
    const saved = await todo.save();

    await this.logRequest('CREATE', `Todo criado: ${title}`, 'POST', '/api/todos', 201);

    return saved;
  }

  async getAllTodos(): Promise<Todo[]> {
    this.logger.log('[SERVICE] Buscando todos os todos');
    const todos = await this.todoModel.find().exec();

    await this.logRequest('GET_ALL', `Retornados ${todos.length} todos`, 'GET', '/api/todos', 200);

    return todos;
  }

  async getTodoById(id: string): Promise<Todo> {
    this.logger.log(`[SERVICE] Buscando todo: ${id}`);
    const todo = await this.todoModel.findById(id).exec();

    await this.logRequest('GET_BY_ID', `Todo encontrado: ${id}`, 'GET', `/api/todos/${id}`, 200);

    return todo;
  }

  async updateTodo(id: string, completed: boolean): Promise<Todo> {
    this.logger.log(`[SERVICE] Atualizando todo ${id} - completed: ${completed}`);
    const todo = await this.todoModel.findByIdAndUpdate(
      id,
      { completed },
      { new: true },
    ).exec();

    await this.logRequest('UPDATE', `Todo ${id} atualizado`, 'PUT', `/api/todos/${id}`, 200);

    return todo;
  }

  async deleteTodo(id: string): Promise<Todo> {
    this.logger.log(`[SERVICE] Deletando todo: ${id}`);
    const todo = await this.todoModel.findByIdAndDelete(id).exec();

    await this.logRequest('DELETE', `Todo ${id} deletado`, 'DELETE', `/api/todos/${id}`, 200);

    return todo;
  }

  async getRequestLog(): Promise<RequestLog[]> {
    this.logger.log('[SERVICE] Buscando logs de requisição');
    return await this.logModel.find().sort({ timestamp: -1 }).limit(100).exec();
  }

  async getRequestLogStats() {
    this.logger.log('[SERVICE] Buscando estatísticas de logs');
    const stats = await this.logModel.aggregate([
      {
        $group: {
          _id: '$action',
          count: { $sum: 1 },
          avgResponseTime: { $avg: '$responseTime' },
        },
      },
    ]).exec();

    return stats;
  }

  private async logRequest(
    action: string,
    details: string,
    method: string,
    path: string,
    statusCode: number,
    responseTime: number = 0,
  ) {
    try {
      const log = new this.logModel({
        action,
        details,
        method,
        path,
        statusCode,
        responseTime,
        timestamp: new Date(),
      });
      await log.save();
      this.logger.debug(`[LOG] ${action} - ${details}`);
    } catch (error) {
      this.logger.error('[LOG_ERROR] Erro ao salvar log', error);
    }
  }
}
