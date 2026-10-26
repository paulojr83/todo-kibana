import { Controller, Get, Post, Put, Delete, Body, Param, Logger } from '@nestjs/common';
import { TodosService } from './todos.service';

@Controller('api/todos')
export class TodosController {
  private readonly logger = new Logger(TodosController.name);

  constructor(private todosService: TodosService) {}

  @Post()
  async create(@Body() { title }: { title: string }) {
    const startTime = Date.now();
    this.logger.log(`[CONTROLLER] POST /api/todos - Criando: ${title}`);

    const result = await this.todosService.createTodo(title);
    const responseTime = Date.now() - startTime;

    this.logger.log(`[CONTROLLER] Resposta em ${responseTime}ms`);
    return { ...result.toObject(), responseTime };
  }

  @Get()
  async getAll() {
    const startTime = Date.now();
    this.logger.log('[CONTROLLER] GET /api/todos - Buscando todos');

    const result = await this.todosService.getAllTodos();
    const responseTime = Date.now() - startTime;

    this.logger.log(`[CONTROLLER] ${result.length} todos retornados em ${responseTime}ms`);
    return { data: result, responseTime, count: result.length };
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    const startTime = Date.now();
    this.logger.log(`[CONTROLLER] GET /api/todos/${id}`);

    const result = await this.todosService.getTodoById(id);
    const responseTime = Date.now() - startTime;

    return { ...result.toObject(), responseTime };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() { completed }: { completed: boolean }) {
    const startTime = Date.now();
    this.logger.log(`[CONTROLLER] PUT /api/todos/${id} - completed: ${completed}`);

    const result = await this.todosService.updateTodo(id, completed);
    const responseTime = Date.now() - startTime;

    return { ...result.toObject(), responseTime };
  }

  @Delete(':id')
  async delete(@Param('id') id: string) {
    const startTime = Date.now();
    this.logger.log(`[CONTROLLER] DELETE /api/todos/${id}`);

    const result = await this.todosService.deleteTodo(id);
    const responseTime = Date.now() - startTime;

    this.logger.log(`[CONTROLLER] Deletado em ${responseTime}ms`);
    return { success: true, deleted: result, responseTime };
  }

  @Get('logs/trace')
  async getTrace() {
    this.logger.log('[CONTROLLER] GET /api/todos/logs/trace');
    return await this.todosService.getRequestLog();
  }

  @Get('logs/stats')
  async getStats() {
    this.logger.log('[CONTROLLER] GET /api/todos/logs/stats');
    return await this.todosService.getRequestLogStats();
  }
}
