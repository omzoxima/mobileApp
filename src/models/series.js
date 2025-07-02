import { DataTypes } from 'sequelize';

export default (sequelize) => {
  const Series = sequelize.define('Series', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT
    },
    releaseYear: {
      type: DataTypes.INTEGER
    },
    thumbnail_url: {
      type: DataTypes.STRING
    },
    category_id: {
      type: DataTypes.UUID,
      references: {
        model: 'categories',
        key: 'id'
      }
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING)
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  }, {
    tableName: 'series',
    timestamps: false
  });

  return Series;
};