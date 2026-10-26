import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class RequestLog extends Document {
  @Prop({ required: true })
  action: string;

  @Prop()
  details: string;

  @Prop()
  method: string;

  @Prop()
  path: string;

  @Prop()
  statusCode: number;

  @Prop()
  responseTime: number;

  @Prop()
  timestamp: Date;

  @Prop()
  userId?: string;

  @Prop()
  ipAddress?: string;
}

export const RequestLogSchema = SchemaFactory.createForClass(RequestLog);
